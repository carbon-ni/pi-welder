import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoveryGuidance,
  clearRecovery,
  consumeRecoveryGuidance,
  createRecoveryState,
  extractToolErrorText,
  recordToolResult,
  setRecoveryLimit,
} from "./recovery.ts";

test("extractToolErrorText returns empty string for successful results", () => {
  assert.equal(extractToolErrorText({ isError: false, content: [{ type: "text", text: "ok" }] }), "");
});

test("extractToolErrorText extracts text content from failing result", () => {
  const text = extractToolErrorText({
    isError: true,
    content: [
      { type: "text", text: "first line" },
      { type: "text", text: "second line" },
    ],
  });
  assert.equal(text, "first line\nsecond line");
});

test("extractToolErrorText supports string and object content", () => {
  assert.equal(extractToolErrorText({ isError: true, content: "boom" }), "boom");
  assert.equal(extractToolErrorText({ isError: true, content: { message: "nope" } }), '{"message":"nope"}');
});

test("recordToolResult records only failing results", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: { path: "a.ts" }, isError: false, content: "ok" });
  assert.equal(state.failures.length, 0);

  recordToolResult(state, { toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT" });
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0]?.toolName, "read");
});

test("recordToolResult keeps only the configured number of recent failures", () => {
  const state = createRecoveryState(2);
  recordToolResult(state, { toolName: "one", input: {}, isError: true, content: "1" });
  recordToolResult(state, { toolName: "two", input: {}, isError: true, content: "2" });
  recordToolResult(state, { toolName: "three", input: {}, isError: true, content: "3" });
  assert.deepEqual(state.failures.map((f) => f.toolName), ["two", "three"]);
});

test("recordToolResult clears failures for a tool after a successful retry", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: {}, isError: true, content: "bad" });
  recordToolResult(state, { toolName: "edit", input: {}, isError: true, content: "bad" });
  recordToolResult(state, { toolName: "read", input: {}, isError: false, content: "ok" });
  assert.deepEqual(state.failures.map((f) => f.toolName), ["edit"]);
});

test("buildRecoveryGuidance returns no messages when there are no failures", () => {
  assert.deepEqual(buildRecoveryGuidance(createRecoveryState()), []);
});

test("buildRecoveryGuidance injects compact tool-failure guidance", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "edit",
    input: { path: "a.ts", oldText: "missing text" },
    isError: true,
    content: "EDIT_MISMATCH: oldText not found in file",
  });

  const messages = buildRecoveryGuidance(state);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /pi-welder recovery hints/);
  assert.match(messages[0]?.content ?? "", /edit/);
  assert.match(messages[0]?.content ?? "", /EDIT_MISMATCH/);
  assert.match(messages[0]?.content ?? "", /read a fresh snippet/i);
});

test("consumeRecoveryGuidance injects once for an unchanged failure snapshot", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT" });

  const first = consumeRecoveryGuidance(state);
  const second = consumeRecoveryGuidance(state);

  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
});

test("consumeRecoveryGuidance injects again when a new failure arrives", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: {}, isError: true, content: "ENOENT" });
  assert.equal(consumeRecoveryGuidance(state).length, 1);
  assert.equal(consumeRecoveryGuidance(state).length, 0);

  recordToolResult(state, { toolName: "edit", input: {}, isError: true, content: "EDIT_MISMATCH" });
  assert.equal(consumeRecoveryGuidance(state).length, 1);
});

test("clearRecovery removes failures and delivered snapshot", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: {}, isError: true, content: "ENOENT" });
  assert.equal(consumeRecoveryGuidance(state).length, 1);

  clearRecovery(state);

  assert.equal(state.failures.length, 0);
  assert.equal(state.deliveredSnapshot, null);
  assert.deepEqual(buildRecoveryGuidance(state), []);
});

test("setRecoveryLimit updates limit and trims older failures", () => {
  const state = createRecoveryState(4);
  recordToolResult(state, { toolName: "one", input: {}, isError: true, content: "1" });
  recordToolResult(state, { toolName: "two", input: {}, isError: true, content: "2" });
  recordToolResult(state, { toolName: "three", input: {}, isError: true, content: "3" });

  setRecoveryLimit(state, 2);

  assert.equal(state.maxFailures, 2);
  assert.deepEqual(state.failures.map((f) => f.toolName), ["two", "three"]);
  assert.equal(state.deliveredSnapshot, null);
});

test("setRecoveryLimit rejects unsafe limits", () => {
  const state = createRecoveryState();

  assert.throws(() => setRecoveryLimit(state, 0), /between 1 and 10/);
  assert.throws(() => setRecoveryLimit(state, 11), /between 1 and 10/);
  assert.throws(() => setRecoveryLimit(state, 1.5), /integer/);
});
