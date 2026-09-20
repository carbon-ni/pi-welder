import { test } from "node:test";
import assert from "node:assert/strict";

import { BASH_JUDGMENT_PROMPT, parseBashJudgment } from "./contract.ts";
import { judgeEligibility } from "./eligibility.ts";
import { createBashRouteState, sentinelArguments, wrapToolForBashRouting, type ToolLike } from "../command-routing/wrapper.ts";

function builtinStub(name: string): ToolLike {
  return {
    name, label: name, description: "builtin", parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "builtin ran" }] }),
  };
}

function harness(options: { enabled?: boolean; trusted?: boolean; judge?: any; judgmentTimeoutMs?: number }) {
  const state = createBashRouteState({ isEnabled: () => options.enabled ?? true, isTrusted: () => options.trusted ?? true });
  const delegated: any[] = [];
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"),
    toolName: "write",
    state,
    delegate: async (request) => { delegated.push(request); return { content: [{ type: "text", text: "bash ran" }], details: {} }; },
    resolveBuiltin: () => builtinStub("write"),
    nextToken: () => `tok-${++tokens}`,
    ...(options.judge === undefined ? {} : { judgeBash: options.judge }),
    ...(options.judgmentTimeoutMs === undefined ? {} : { judgmentTimeoutMs: options.judgmentTimeoutMs }),
  });
  return { wrapper, state, delegated };
}

const ctx = () => ({ cwd: "/work", isProjectTrusted: () => true });

test("the dedicated contract has its own prompt and closed answer shape", () => {
  assert.match(BASH_JUDGMENT_PROMPT, /Classify one string/);
  assert.deepEqual(parseBashJudgment({ answers: { bash: { choice: "bash", confidence: 0.9 } } }), { verdict: "bash", confidence: 0.9 });
  assert.deepEqual(parseBashJudgment(JSON.stringify({ answers: { bash: { choice: "not-bash" } } })), { verdict: "not-bash" });
  // Other questions' answers are never accepted.
  assert.equal(parseBashJudgment({ answers: { selection: { choice: 1 } } }), undefined);
  assert.equal(parseBashJudgment({ answers: { mapping: { choice: "bash" } } }), undefined);
  assert.equal(parseBashJudgment({ answers: { bash: { choice: "maybe" } } }), undefined);
  assert.equal(parseBashJudgment({ answers: { bash: { choice: "bash", confidence: 2 } } }), undefined);
  assert.equal(parseBashJudgment("not json"), undefined);
});

test("eligibility needs exactly one bounded safe-key string plus an optional canonical timeout", () => {
  assert.deepEqual(judgeEligibility({ CMD: "git status" }), { eligible: true, candidate: { key: "CMD", candidate: "git status" } });
  assert.deepEqual(judgeEligibility({ CMD: "ls", timeout: 30 }), { eligible: true, candidate: { key: "CMD", candidate: "ls", timeout: 30 } });
  const rejected: Array<[unknown, string]> = [
    [{}, "empty"],
    [{ CMD: "ls", extra: "x" }, "multiple-fields"],
    [{ CMD: "ls", other: "y", timeout: 5 }, "multiple-fields"],
    [{ "bad key": "ls" }, "unsafe-key"],
    [{ CMD: 42 }, "not-a-string"],
    [{ CMD: "   " }, "empty-string"],
    [{ CMD: "x".repeat(600) }, "oversized"],
    [{ CMD: "ls", timeout: 0 }, "invalid-timeout"],
    [{ CMD: "ls", timeout: "30" }, "invalid-timeout"],
    ["ls", "not-an-object"],
  ];
  for (const [input, reason] of rejected) {
    const result = judgeEligibility(input);
    assert.equal(result.eligible, false, JSON.stringify(input));
    assert.equal(result.reason, reason, JSON.stringify(input));
  }
});

test("an exact bash shape stays deterministic and never calls the classifier", async () => {
  let judged = 0;
  const { wrapper, delegated } = harness({ judge: { judge: async () => { judged++; return { answers: { bash: { choice: "bash" } } }; } } });
  const prepared = wrapper.prepareArguments!({ command: "git status" });
  assert.equal(JSON.stringify(prepared).includes("git status"), false, "sentinel carries no command");
  await wrapper.execute("c1", prepared, undefined, undefined, ctx());
  assert.equal(judged, 0, "the deterministic shape is Jev-free");
  assert.equal(delegated.length, 1);
});

test("a bash verdict routes the original value unchanged; not-bash fails closed", async () => {
  const yes = harness({ judge: { judge: async (request: any) => { assert.deepEqual(request, { attemptedTool: "write", key: "CMD", candidate: "git status" }); return { answers: { bash: { choice: "bash" } } }; } } });
  const prepared = yes.wrapper.prepareArguments!({ CMD: "git status" });
  const result = await yes.wrapper.execute("c1", prepared, undefined, undefined, ctx());
  assert.equal(result.content[0].text, "bash ran");
  assert.equal(yes.delegated.length, 1);
  assert.equal(yes.delegated[0].command, "git status", "the original value is unchanged");

  const no = harness({ judge: { judge: async () => ({ answers: { bash: { choice: "not-bash" } } }) } });
  const notBash = no.wrapper.prepareArguments!({ CMD: "git status" });
  await assert.rejects(() => no.wrapper.execute("c1", notBash, undefined, undefined, ctx()), /classified as not-bash/);
  assert.equal(no.delegated.length, 0, "no execution on a not-bash verdict");
});

test("unavailable, malformed, and timed-out judgments fail closed without execution", async () => {
  const cases: Array<[string, any, number | undefined]> = [
    ["unavailable", { judge: async () => { throw new Error("offline"); } }, undefined],
    ["malformed", { judge: async () => "not json" }, undefined],
    ["wrong shape", { judge: async () => ({ answers: { selection: { choice: 1 } } }) }, undefined],
    ["timeout", { judge: async () => new Promise((resolve) => setTimeout(() => resolve({ answers: { bash: { choice: "bash" } } }), 200)) }, 20],
  ];
  for (const [label, judgeOptions, timeout] of cases) {
    const h = harness({ ...judgeOptions, ...(timeout === undefined ? {} : { judgmentTimeoutMs: timeout }) });
    const prepared = h.wrapper.prepareArguments!({ CMD: "git status" });
    await assert.rejects(() => h.wrapper.execute("c1", prepared, undefined, undefined, ctx()), /refused to route/, label);
    assert.equal(h.delegated.length, 0, label);
  }
});

test("disabled, untrusted, ineligible, and aborted calls never judge or execute", async () => {
  let judged = 0;
  const judge = { judge: async () => { judged++; return { answers: { bash: { choice: "bash" } } }; } };

  const disabled = harness({ enabled: false, judge });
  assert.deepEqual(disabled.wrapper.prepareArguments!({ CMD: "git status" }), { CMD: "git status" }, "disabled leaves args for native validation");

  const untrusted = harness({ trusted: false, judge });
  assert.deepEqual(untrusted.wrapper.prepareArguments!({ CMD: "git status" }), { CMD: "git status" }, "untrusted leaves args for native validation");

  const ineligible = harness({ judge });
  for (const args of [{ path: "a", content: "b" }, { CMD: "ls", extra: "x" }, { CMD: "x".repeat(600) }, { CMD: "ls", timeout: 0 }]) {
    assert.deepEqual(ineligible.wrapper.prepareArguments!(args), args, "ineligible shapes are never judged");
  }
  assert.equal(judged, 0);

  const aborted = harness({ judge });
  const prepared = aborted.wrapper.prepareArguments!({ CMD: "git status" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => aborted.wrapper.execute("c1", prepared, controller.signal, undefined, ctx()), /refused to route/);
  assert.equal(aborted.delegated.length, 0);
});
