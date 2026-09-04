import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearRecovery,
  createRecoveryState,
  extractToolErrorText,
  recordToolResult,
  recoveryFailuresSummary,
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

test("clearRecovery removes failures", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: {}, isError: true, content: "ENOENT" });

  clearRecovery(state);

  assert.equal(state.failures.length, 0);
});

test("setRecoveryLimit updates limit and trims older failures", () => {
  const state = createRecoveryState(4);
  recordToolResult(state, { toolName: "one", input: {}, isError: true, content: "1" });
  recordToolResult(state, { toolName: "two", input: {}, isError: true, content: "2" });
  recordToolResult(state, { toolName: "three", input: {}, isError: true, content: "3" });

  setRecoveryLimit(state, 2);

  assert.equal(state.maxFailures, 2);
  assert.deepEqual(state.failures.map((f) => f.toolName), ["two", "three"]);
});

test("setRecoveryLimit rejects unsafe limits", () => {
  const state = createRecoveryState();

  assert.throws(() => setRecoveryLimit(state, 0), /between 1 and 10/);
  assert.throws(() => setRecoveryLimit(state, 11), /between 1 and 10/);
  assert.throws(() => setRecoveryLimit(state, 1.5), /integer/);
});

test("recoveryFailuresSummary renders pending failures", () => {
  const state = createRecoveryState();
  recordToolResult(state, { toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT: no such file\nmore" });
  recordToolResult(state, { toolName: "edit", input: { path: "a.ts", oldText: "x" }, isError: true, content: "EDIT_MISMATCH" });

  const summary = recoveryFailuresSummary(state);

  assert.match(summary, /pending recovery failures/);
  assert.match(summary, /read failed: ENOENT/);
  assert.match(summary, /input keys: path/);
  assert.match(summary, /edit failed: EDIT_MISMATCH/);
});

test("recoveryFailuresSummary handles empty state", () => {
  assert.equal(recoveryFailuresSummary(createRecoveryState()), "pi-welder: no pending recovery failures");
});
