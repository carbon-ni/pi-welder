import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BASH_TIMEOUT_MAX_SECONDS,
  MAX_COMMAND_BYTES,
  MAX_ROUTE_TOKENS,
  MAX_TOTAL_COMMAND_BYTES,
  ROUTE_SENTINEL_PREFIX,
  clearBashRouteTokens,
  createBashRouteState,
  recognizeBashShapedCall,
  routeRefusalMessage,
  sentinelArguments,
  sentinelTokenOf,
  wrapToolForBashRouting,
  type BashRouteState,
  type ToolLike,
} from "./index.ts";

test("recognizes only exact bash shapes on read, write, and edit", () => {
  for (const tool of ["read", "write", "edit"]) {
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls -la" }), { command: "ls -la" });
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls -la", timeout: 30 }), { command: "ls -la", timeout: 30 });
  }
  assert.equal(recognizeBashShapedCall("bash", { command: "ls" }), undefined, "attempted bash is never rerouted");
  assert.equal(recognizeBashShapedCall("ast_map", { command: "ls" }), undefined, "unknown tools are never rerouted");
});

test("abstains on unknown fields, missing command, invalid types, and bad ranges", () => {
  for (const tool of ["read", "write", "edit"]) {
    assert.equal(recognizeBashShapedCall(tool, {}), undefined);
    assert.equal(recognizeBashShapedCall(tool, { timeout: 5 }), undefined, "command is mandatory");
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", path: "a.ts" }), undefined, "extra key");
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: 5, cwd: "/tmp" }), undefined, "extra key");
    assert.equal(recognizeBashShapedCall(tool, { command: "" }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "   " }), undefined, "whitespace-only command");
    assert.equal(recognizeBashShapedCall(tool, { command: 42 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: "5" }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: Number.NaN }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: Number.POSITIVE_INFINITY }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: 0 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: -1 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS + 1 }), undefined);
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS }), { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS }, "maximum accepted timeout is inclusive");
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls", timeout: undefined }), { command: "ls" }, "an explicit undefined timeout is treated as absent");
    assert.equal(recognizeBashShapedCall(tool, null), undefined);
    assert.equal(recognizeBashShapedCall(tool, "ls"), undefined);
    assert.equal(recognizeBashShapedCall(tool, ["ls"]), undefined);
  }
});

test("sentinels are schema-shaped per tool and carry an opaque token only", () => {
  assert.deepEqual(sentinelArguments("read", "tok1"), { path: `${ROUTE_SENTINEL_PREFIX}tok1` });
  assert.deepEqual(sentinelArguments("write", "tok1"), { path: `${ROUTE_SENTINEL_PREFIX}tok1`, content: "" });
  assert.deepEqual(sentinelArguments("edit", "tok1"), { path: `${ROUTE_SENTINEL_PREFIX}tok1`, edits: [] });

  assert.equal(sentinelTokenOf(sentinelArguments("write", "tok1")), "tok1");
  assert.equal(sentinelTokenOf({ path: "src/a.ts", content: "" }), undefined);
  assert.equal(sentinelTokenOf({ path: ROUTE_SENTINEL_PREFIX }), undefined, "empty token is not a route");
  assert.equal(sentinelTokenOf(null), undefined);
  assert.equal(sentinelTokenOf("x"), undefined);
  const encoded = JSON.stringify(sentinelArguments("write", "tok1"));
  assert.equal(encoded.includes("command"), false);
  assert.equal(encoded.includes("ls"), false);
});

function builtinStub(name: string): ToolLike {
  return {
    name,
    label: `${name} (builtin)`,
    description: "builtin",
    parameters: { type: "object" },
    promptSnippet: "snippet",
    prepareArguments: (args: unknown) => args,
    execute: async () => ({ content: [{ type: "text", text: "builtin ran" }], details: { builtin: true } }),
    renderCall: () => ({ render: () => ["builtin call"], invalidate: () => {} }),
    renderResult: () => ({ render: () => ["builtin result"], invalidate: () => {} }),
  };
}

function state(overrides: Partial<{ enabled: boolean; trusted: boolean }> = {}): BashRouteState {
  return createBashRouteState({ isEnabled: () => overrides.enabled ?? true, isTrusted: () => overrides.trusted ?? true });
}

const trustedCtx = (cwd = "/tmp/project") => ({ cwd, isProjectTrusted: () => true });

test("prepareArguments replaces an exact bash shape with a sentinel and stores the command", () => {
  const routeState = state();
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"),
    nextToken: () => `tok-${++tokens}`,
  });

  const prepared = wrapper.prepareArguments!({ command: "ls -la", timeout: 10 }) as Record<string, unknown>;
  assert.deepEqual(prepared, { path: `${ROUTE_SENTINEL_PREFIX}tok-1`, content: "" });
  assert.deepEqual(routeState.tokens.get("tok-1"), { sourceTool: "write", command: "ls -la", timeout: 10 });
  assert.equal(JSON.stringify(prepared).includes("ls -la"), false, "the sentinel never carries the command");
});

test("prepareArguments leaves every other shape unchanged for native validation", () => {
  const routeState = state();
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"), nextToken: () => "tok",
  });

  for (const args of [{ path: "a.ts", content: "x" }, { command: "ls", path: "a.ts" }, { command: "" }, {}, { path: "a.ts" }]) {
    assert.deepEqual(wrapper.prepareArguments!(args), args, JSON.stringify(args));
  }
  assert.equal(routeState.tokens.size, 0);
});

test("prepareArguments abstains when the setting is off or the project is untrusted", () => {
  for (const flags of [{ enabled: false, trusted: true }, { enabled: true, trusted: false }, { enabled: false, trusted: false }]) {
    const routeState = state(flags);
    const wrapper = wrapToolForBashRouting({
      builtin: builtinStub("edit"), toolName: "edit", state: routeState,
      delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("edit"), nextToken: () => "tok",
    });
    assert.deepEqual(wrapper.prepareArguments!({ command: "ls" }), { command: "ls" }, JSON.stringify(flags));
    assert.equal(routeState.tokens.size, 0, "no token stored when the gate is closed");
  }
});

test("execute routes a stored token to bash once and returns a non-error success", async () => {
  const routeState = state();
  const calls: any[] = [];
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async (request) => { calls.push(request); return { content: [{ type: "text", text: "bash output" }], details: { bash: true } }; },
    resolveBuiltin: () => { throw new Error("builtin must not run for a routed call"); },
    nextToken: () => `tok-${++tokens}`,
  });

  const prepared = wrapper.prepareArguments!({ command: "printf hi", timeout: 5 });
  const result: any = await wrapper.execute("call-1", prepared, undefined, undefined, trustedCtx("/work"));

  assert.notEqual(result.isError, true, "success is never marked as an error");
  assert.deepEqual(result, { content: [{ type: "text", text: "bash output" }], details: { bash: true } });
  assert.deepEqual(calls, [{ toolCallId: "call-1", command: "printf hi", timeout: 5, cwd: "/work" }]);
  assert.equal(routeState.tokens.size, 0, "token consumed");
});

test("execute consumes the token once and refuses an untrusted context", async () => {
  const routeState = state();
  let calls = 0;
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("read"), toolName: "read", state: routeState,
    delegate: async () => { calls++; return { content: [{ type: "text", text: "ran" }] }; },
    resolveBuiltin: () => { throw new Error("the built-in must never run for a sentinel"); },
    nextToken: () => `tok-${++tokens}`,
  });

  const refusedSentinel = wrapper.prepareArguments!({ command: "echo hi" });
  await assert.rejects(
    () => wrapper.execute("call-1", refusedSentinel, undefined, undefined, { cwd: "/work", isProjectTrusted: () => false }),
    /untrusted project/,
  );
  assert.equal(calls, 0, "no execution for an untrusted context");
  assert.equal(routeState.tokens.size, 0, "the token is still consumed");

  const trustedSentinel = wrapper.prepareArguments!({ command: "echo hi" });
  const first = await wrapper.execute("call-2", trustedSentinel, undefined, undefined, trustedCtx());
  assert.equal(first.isError, undefined);
  assert.equal(calls, 1);
  await assert.rejects(
    () => wrapper.execute("call-2", trustedSentinel, undefined, undefined, trustedCtx()),
    /unknown or expired token/,
  );
  assert.equal(calls, 1, "a consumed token never executes twice");
});

test("normal calls delegate to the built-in definition for the current cwd", async () => {
  const seen: string[] = [];
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("edit"), toolName: "edit", state: state(),
    delegate: async () => { throw new Error("bash must not run for a normal call"); },
    resolveBuiltin: (cwd) => {
      seen.push(cwd);
      return { ...builtinStub("edit"), execute: async () => ({ content: [{ type: "text", text: `builtin@${cwd}` }], details: {} }) };
    },
    nextToken: () => "tok",
  });

  const result = await wrapper.execute("call-1", { path: "a.ts", edits: [] }, undefined, undefined, trustedCtx("/work"));
  assert.equal(result.content[0].text, "builtin@/work");
  assert.deepEqual(seen, ["/work"]);
});

test("a delegate failure is reported as an error, never as success", async () => {
  const routeState = state();
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => { throw new Error("spawn failed"); },
    resolveBuiltin: () => { throw new Error("builtin must not run"); },
    nextToken: () => `tok-${++tokens}`,
  });

  const prepared = wrapper.prepareArguments!({ command: "nope" });
  await assert.rejects(
    () => wrapper.execute("call-1", prepared, undefined, undefined, trustedCtx()),
    /bash execution failed.*spawn failed/s,
  );
});

test("the routed audit signal carries source and target tool names only", async () => {
  const audits: any[] = [];
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("edit"), toolName: "edit", state: state(),
    delegate: async () => ({ content: [] }), resolveBuiltin: () => { throw new Error("builtin must not run"); },
    nextToken: () => `tok-${++tokens}`, onRouted: (audit) => audits.push(audit),
  });

  const prepared = wrapper.prepareArguments!({ command: "touch SECRET" });
  await wrapper.execute("call-1", prepared, undefined, undefined, trustedCtx());

  assert.deepEqual(audits, [{ sourceTool: "edit", targetTool: "bash", toolCallId: "call-1" }]);
  assert.equal(JSON.stringify(audits).includes("SECRET"), false, "the command never reaches the audit signal");
});

test("the token store is bounded and clearable", () => {
  const routeState = state();
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"),
    nextToken: () => `tok-${++tokens}`,
  });

  for (let index = 0; index < MAX_ROUTE_TOKENS + 5; index++) wrapper.prepareArguments!({ command: `echo ${index}` });
  assert.equal(routeState.tokens.size, MAX_ROUTE_TOKENS, "bounded");
  assert.equal(routeState.tokens.has("tok-1"), false, "oldest evicted");

  clearBashRouteTokens(routeState);
  assert.equal(routeState.tokens.size, 0);
});

test("sentinels render as a safe notice and normal calls keep the built-in renderer", () => {
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: state(),
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"), nextToken: () => "tok",
  });

  const sentinelCall = wrapper.renderCall!(sentinelArguments("write", "tok"), {}, { cwd: "/work" })!;
  const callLines = sentinelCall!.render(80);
  assert.equal(callLines.join(" ").includes("command hidden"), true);
  assert.equal(callLines.join(" ").includes("tok"), false, "the token is never rendered");

  const normalCall = wrapper.renderCall!({ path: "a.ts", content: "x" }, {}, { cwd: "/work" })!;
  assert.deepEqual(normalCall.render(80), ["builtin call"]);


  const sentinelResult = wrapper.renderResult!({ content: [{ type: "text", text: "line one\nline two" }], details: {} }, {}, {}, { cwd: "/work", args: sentinelArguments("write", "tok"), isError: false })!;
  assert.deepEqual(sentinelResult.render(80), ["bash (routed write) — completed", "line one", "line two"]);

  const normalResult = wrapper.renderResult!({ content: [], details: {} }, {}, {}, { cwd: "/work", args: { path: "a.ts" }, isError: false })!;
  assert.deepEqual(normalResult.render(80), ["builtin result"]);
});

test("the refusal message is bounded, names the reason, and never contains a command", () => {
  const message = routeRefusalMessage("read", "unknown or expired token");
  assert.match(message, /refused to route this read call/);
  assert.match(message, /unknown or expired token/);
  assert.match(message, /original call was not executed/);
});

test("a sentinel-looking argument without a live token fails closed and never reaches the built-in", async () => {
  let builtinRuns = 0;
  const routeState = state();
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => { throw new Error("bash must not run"); },
    resolveBuiltin: () => ({ ...builtinStub("write"), execute: async () => { builtinRuns++; return { content: [] }; } }),
    nextToken: () => "tok",
  });

  // Unknown token, evicted-looking token, and a bare sentinel path must all refuse.
  for (const params of [
    sentinelArguments("write", "unknown"),
    sentinelArguments("write", "evicted"),
  ]) {
    await assert.rejects(
      () => wrapper.execute("call-1", params, undefined, undefined, trustedCtx()),
      /refused to route this write call/,
      JSON.stringify(params),
    );
  }
  assert.equal(builtinRuns, 0, "a sentinel never becomes a normal file operation");

  // A cleared store behaves the same.
  routeState.tokens.set("tok", { sourceTool: "write", command: "echo hi" });
  clearBashRouteTokens(routeState);
  await assert.rejects(() => wrapper.execute("call-2", sentinelArguments("write", "tok"), undefined, undefined, trustedCtx()));
  assert.equal(builtinRuns, 0);
});

test("a token bound to another tool fails closed and never delegates", async () => {
  const routeState = state();
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("read"), toolName: "read", state: routeState,
    delegate: async () => { throw new Error("bash must not run"); },
    resolveBuiltin: () => { throw new Error("the built-in must never run"); },
    nextToken: () => "tok",
  });
  routeState.tokens.set("tok", { sourceTool: "write", command: "echo hi" });

  await assert.rejects(
    () => wrapper.execute("call-1", sentinelArguments("read", "tok"), undefined, undefined, trustedCtx()),
    /token belongs to another tool/,
  );
  assert.equal(routeState.tokens.size, 0, "the mismatched token is consumed");
});

test("execute re-checks the live gate and refuses after routing is disabled", async () => {
  const routeState = state();
  let tokens = 0;
  let calls = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => { calls++; return { content: [] }; },
    resolveBuiltin: () => { throw new Error("the built-in must never run"); },
    nextToken: () => `tok-${++tokens}`,
  });
  const prepared = wrapper.prepareArguments!({ command: "echo hi" });
  assert.equal(routeState.tokens.size, 1);

  routeState.isEnabled = () => false;
  await assert.rejects(() => wrapper.execute("call-1", prepared, undefined, undefined, trustedCtx()), /routing disabled/);
  assert.equal(calls, 0);
  assert.equal(routeState.tokens.size, 0, "consumed even when refused");
});

test("oversized commands stay native and command bytes are capped in the store", () => {
  const routeState = state();
  let tokens = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: routeState,
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"),
    nextToken: () => `tok-${++tokens}`,
  });

  const oversized = { command: "x".repeat(MAX_COMMAND_BYTES + 1) };
  assert.deepEqual(wrapper.prepareArguments!(oversized), oversized, "oversized commands are never stored");
  assert.equal(routeState.tokens.size, 0);

  const big = `echo ${"y".repeat(4_000)}`;
  for (let index = 0; index < 20; index++) wrapper.prepareArguments!({ command: big });
  let total = 0;
  for (const stored of routeState.tokens.values()) total += Buffer.byteLength(stored.command, "utf8");
  assert.equal(total <= MAX_TOTAL_COMMAND_BYTES, true, `total bytes bounded, got ${total}`);
});

test("renderers treat original bash args as routed, so the command is never rendered", () => {
  const wrapper = wrapToolForBashRouting({
    builtin: builtinStub("write"), toolName: "write", state: state(),
    delegate: async () => ({ content: [] }), resolveBuiltin: () => builtinStub("write"), nextToken: () => "tok",
  });

  // Pi may hand the ORIGINAL assistant arguments to the renderer.
  const originalCall = wrapper.renderCall!({ command: "echo SECRET", timeout: 5 }, {}, { cwd: "/work" })!;
  assert.equal(originalCall.render(80).join(" ").includes("SECRET"), false, "the command is never rendered");

  const originalResult = wrapper.renderResult!({ content: [{ type: "text", text: "out" }] }, {}, {}, { cwd: "/work", args: { command: "echo SECRET", timeout: 5 }, isError: false })!;
  assert.equal(originalResult.render(80).join(" ").includes("SECRET"), false);

  // A genuine write call still uses the built-in renderer.
  const normalCall = wrapper.renderCall!({ path: "a.ts", content: "x" }, {}, { cwd: "/work" })!;
  assert.deepEqual(normalCall.render(80), ["builtin call"]);
});
