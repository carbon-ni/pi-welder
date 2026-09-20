/**
 * TASK-0038 — direct tests for the dedicated bash-judge HTTP client.
 * Every test injects a fake fetch: no network, no retry, bounded work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BASH_JUDGE_ENDPOINT, createTypeSafeBashJudgeClient } from "./client.ts";
import { parseBashJudgment } from "./contract.ts";

interface Call { url: string; init: any }

function fakeFetch(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler({ url: String(url), init });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const input = { attemptedTool: "write", key: "CMD", candidate: "git status" };

test("one POST to the endpoint with auth, content type, and redirect refused", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ answers: { bash: { choice: "bash" } } }));
  const client = createTypeSafeBashJudgeClient({ apiKey: "k-123", fetch: fetchImpl });

  await client.judge(input);

  assert.equal(calls.length, 1, "exactly one fetch: zero retry");
  assert.equal(calls[0]!.url, BASH_JUDGE_ENDPOINT);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers.authorization, "Bearer k-123");
  assert.equal(calls[0]!.init.headers["content-type"], "application/json");
  assert.equal(calls[0]!.init.redirect, "error", "the key never follows a redirect");
});

test("the body carries only the three safe state fields plus the bash question", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ answers: { bash: { choice: "not-bash" } } }));
  const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl });

  await client.judge(input);

  const body = JSON.parse(calls[0]!.init.body);
  assert.deepEqual(body.state, { attemptedTool: "write", key: "CMD", candidate: "git status" });
  assert.deepEqual(Object.keys(body.state), ["attemptedTool", "key", "candidate"], "no extra state leaks");
  assert.deepEqual(Object.keys(body.questions), ["bash"], "never selection or mapping");
  assert.equal(body.questions.bash.type, "choice");
  assert.deepEqual(Object.keys(body.questions.bash.criteria), ["bash", "not-bash"]);
  assert.equal(typeof body.questions.bash.instructions, "string");
  assert.equal(body.model, "jev-latest");

  const occurrences = calls[0]!.init.body.split("git status").length - 1;
  assert.equal(occurrences, 1, "the raw candidate appears exactly once, as intended");
});

test("the endpoint and model are injectable, and the raw payload reaches the shared parser", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ answers: { bash: { choice: "bash", confidence: 0.8 } } }));
  const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl, endpoint: "https://example.test/judge", model: "jev-test" });

  const payload = await client.judge(input);

  assert.equal(calls[0]!.url, "https://example.test/judge");
  assert.equal(JSON.parse(calls[0]!.init.body).model, "jev-test");
  assert.deepEqual(parseBashJudgment(payload), { verdict: "bash", confidence: 0.8 });
});

test("an aborted turn signal propagates and cancels the request", async () => {
  let seen: AbortSignal | undefined;
  const { fetchImpl } = fakeFetch(({ init }) => {
    seen = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl });
  const controller = new AbortController();

  const pending = client.judge(input, controller.signal);
  controller.abort();

  await assert.rejects(() => pending, /aborted/);
  assert.equal(seen?.aborted, true, "the combined signal is already aborted");
});

test("an already-aborted signal never reaches a resolved request", async () => {
  const { fetchImpl } = fakeFetch(({ init }) => {
    if (init.signal.aborted) throw new Error("aborted before send");
    return jsonResponse({ answers: { bash: { choice: "bash" } } });
  });
  const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => client.judge(input, controller.signal), /aborted/);
});

test("non-ok responses fail closed after exactly one request", async () => {
  for (const status of [400, 429, 500, 503]) {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ error: "nope" }, status));
    const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl });

    await assert.rejects(() => client.judge(input), /bash judge failed: \d+/, String(status));
    assert.equal(calls.length, 1, `status ${status}: no retry`);
  }
});

test("network failure and malformed JSON fail closed after exactly one request", async () => {
  const failing = fakeFetch(() => { throw new Error("network down"); });
  await assert.rejects(() => createTypeSafeBashJudgeClient({ apiKey: "k", fetch: failing.fetchImpl }).judge(input), /network down/);
  assert.equal(failing.calls.length, 1, "no retry after a transport failure");

  const malformed = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
  await assert.rejects(() => createTypeSafeBashJudgeClient({ apiKey: "k", fetch: malformed.fetchImpl }).judge(input), /bad json/);
  assert.equal(malformed.calls.length, 1, "no retry after a malformed body");
});

test("the deadline bounds a hung request without a retry", async () => {
  const { fetchImpl, calls } = fakeFetch(({ init }) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("deadline")))));
  const client = createTypeSafeBashJudgeClient({ apiKey: "k", fetch: fetchImpl, timeoutMs: 20 });

  // `AbortSignal.timeout` timers are unref'd, so keep the loop alive while we wait.
  const keepAlive = setTimeout(() => {}, 200);
  const started = Date.now();
  try {
    await assert.rejects(() => client.judge(input), /deadline/);
    assert.ok(Date.now() - started < 2_000, "bounded wait");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls.length, 1, "a timeout is not retried");
});
