import { test } from "node:test";
import assert from "node:assert/strict";

import { createJevShadow, type ShadowEvidence, type ShadowRequest } from "./jev-shadow.ts";

function request(id = "call-1"): ShadowRequest {
  return {
    toolCallId: id,
    path: "src/example.ts",
    candidates: [
      { ordinal: 1, window: "first candidate" },
      { ordinal: 2, window: "second candidate" },
    ],
    requestedEditText: "replacement",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("shadow selection is non-blocking and records a high-confidence choice", async () => {
  const wait = deferred<{ choice: number | null; confidence?: number; model?: string }>();
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    client: { choose: async () => wait.promise },
    onEvidence: (record) => { evidence.push(record); },
  });

  assert.equal(shadow.submit(request()), true);
  assert.equal(shadow.inFlight, 1);
  await Promise.resolve();
  wait.resolve({ choice: 2, confidence: 0.99, model: "jev-test" });
  await shadow.drain();

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.selectedOrdinal, 2);
  assert.equal(evidence[0]?.status, "selected");
  assert.equal(evidence[0]?.labelStatus, "pending");
});

test("only one request runs at once and the session cap is ten", async () => {
  const waits = Array.from({ length: 11 }, () => deferred<{ choice: null; confidence: number }>());
  let calls = 0;
  const shadow = createJevShadow({
    client: { choose: async (_request, _signal) => waits[calls++]!.promise },
  });

  assert.equal(shadow.submit(request("first")), true);
  assert.equal(shadow.submit(request("second")), false);
  waits[0]!.resolve({ choice: null, confidence: 1 });
  await shadow.drain();
  for (let index = 0; index < 9; index++) {
    assert.equal(shadow.submit(request(`call-${index}`)), true);
    waits[index + 1]!.resolve({ choice: null, confidence: 1 });
    await shadow.drain();
  }
  assert.equal(shadow.submit(request("eleven")), false);
  assert.equal(calls, 10);
});

test("invalid and low-confidence answers abstain without affecting input", async () => {
  const evidence: ShadowEvidence[] = [];
  const answers = [
    { choice: 3, confidence: 1 },
    { choice: 1, confidence: 0.98 },
    { choice: null, confidence: 1 },
  ];
  const shadow = createJevShadow({
    client: { choose: async () => answers.shift()! },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit(request("a")), true);
  await shadow.drain();
  assert.equal(shadow.submit(request("b")), true);
  await shadow.drain();
  assert.equal(shadow.submit(request("c")), true);
  await shadow.drain();
  assert.equal(evidence[0]?.status, "malformed");
  assert.equal(evidence[1]?.status, "low-confidence");
  assert.equal(evidence[2]?.status, "abstain");
});

test("timeout aborts the client and cancellation ignores late results", async () => {
  const wait = deferred<{ choice: 1; confidence: 1 }>();
  let aborted = false;
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    timeoutMs: 10,
    client: { choose: async (_request, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return wait.promise;
    } },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit(request()), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(evidence[0]?.status, "timeout");
  assert.equal(aborted, true);

  const second = deferred<{ choice: 1; confidence: 1 }>();
  const cancelled = createJevShadow({
    client: { choose: async () => second.promise },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(cancelled.submit(request("cancel")), true);
  await cancelled.shutdown(5);
  assert.equal(evidence.at(-1)?.status, "cancelled");
  second.resolve({ choice: 1, confidence: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evidence.at(-1)?.status, "cancelled");
});

test("labels only a uniquely correlated successful retry", async () => {
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    client: { choose: async () => ({ choice: 2, confidence: 1, model: "jev" }) },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit(request()), true);
  await shadow.drain();

  shadow.observeToolCall({ toolName: "edit", toolCallId: "retry", path: "src/example.ts", oldText: "second candidate" });
  shadow.observeToolResult({ toolName: "edit", toolCallId: "retry", isError: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evidence.at(-1)?.labelStatus, "provisional-correct");

  const unresolvedEvidence: ShadowEvidence[] = [];
  const unresolved = createJevShadow({
    client: { choose: async () => ({ choice: 1, confidence: 1 }) },
    onEvidence: (record) => { unresolvedEvidence.push(record); },
  });
  assert.equal(unresolved.submit(request("x")), true);
  await unresolved.drain();
  unresolved.observeToolCall({ toolName: "edit", toolCallId: "wrong-id", path: "src/example.ts", oldText: "first candidate" });
  unresolved.observeToolResult({ toolName: "edit", toolCallId: "wrong-id", isError: false });
  assert.equal(unresolvedEvidence.at(-1)?.labelStatus, "provisional-correct");
});

test("an ambiguous retry mapping to multiple candidates stays unlabeled", async () => {
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    client: { choose: async () => ({ choice: 1, confidence: 1 }) },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit(request("first")), true);
  await shadow.drain();
  assert.equal(shadow.submit(request("second")), true);
  await shadow.drain();

  // Both open selections share an identical candidate window: not unique.
  shadow.observeToolCall({ toolName: "edit", toolCallId: "retry", path: "src/example.ts", oldText: "first candidate" });
  shadow.observeToolResult({ toolName: "edit", toolCallId: "retry", isError: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((record) => record.labelStatus === "pending"));

  // Same candidate window repeated within one selection is also not unique.
  const twin = createJevShadow({
    client: { choose: async () => ({ choice: 1, confidence: 1 }) },
    onEvidence: (record) => { evidence.push(record); },
  });
  twin.submit({ ...request("twin"), candidates: [{ ordinal: 1, window: "same" }, { ordinal: 2, window: "same" }] });
  await twin.drain();
  twin.observeToolCall({ toolName: "edit", toolCallId: "twin-retry", path: "src/example.ts", oldText: "same" });
  twin.observeToolResult({ toolName: "edit", toolCallId: "twin-retry", isError: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((record) => record.labelStatus === "pending"));
});

test("low-confidence evidence is abstention-shaped without a selected ordinal", async () => {
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    client: { choose: async () => ({ choice: 2, confidence: 0.5 }) },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit(request()), true);
  await shadow.drain();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.status, "low-confidence");
  assert.equal(evidence[0]?.selectedOrdinal, undefined);
  assert.ok(!("selectedOrdinal" in evidence[0]!));
});

test("duplicate windows across selections keep global candidate uniqueness (regression)", async () => {
  // c1 = [x, x], c2 = [x, y]; retry oldText "x" matches 3 candidates globally
  // (2 in c1, 1 in c2) -> must stay unlabeled, never link to c2 alone.
  const evidence: ShadowEvidence[] = [];
  const shadow = createJevShadow({
    client: { choose: async () => ({ choice: 1, confidence: 1 }) },
    onEvidence: (record) => { evidence.push(record); },
  });
  assert.equal(shadow.submit({ ...request("c1"), candidates: [{ ordinal: 1, window: "x" }, { ordinal: 2, window: "x" }] }), true);
  await shadow.drain();
  assert.equal(shadow.submit({ ...request("c2"), candidates: [{ ordinal: 1, window: "x" }, { ordinal: 2, window: "y" }] }), true);
  await shadow.drain();

  shadow.observeToolCall({ toolName: "edit", toolCallId: "retry", path: "src/example.ts", oldText: "x" });
  shadow.observeToolResult({ toolName: "edit", toolCallId: "retry", isError: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((record) => record.labelStatus === "pending"));
});
