import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoveryGuidance,
  clearRecovery,
  consumeRecoveryGuidance,
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

test("buildRecoveryGuidance uses included edit context before asking for another read", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "edit",
    input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
    isError: true,
    content: "oldText must match exactly\n\nCurrent context edits[0] lines 1-3 (1/1):\nconst x = 1;",
  });

  const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

  assert.match(guidance, /retry with exact oldText from included context/i);
  assert.doesNotMatch(guidance, /read/i);
});

test("buildRecoveryGuidance identifies missing nested edit fields", () => {
  const cases = [
    ["edits.2.newText: must have required properties newText", "edits[2]", "newText"],
    ["edits[1].oldText: must have required properties oldText", "edits[1]", "oldText"],
    ["must have required properties newText", "an edit entry", "newText"],
    ["must have required properties oldText", "an edit entry", "oldText"],
  ] as const;

  for (const [errorText, location, field] of cases) {
    const state = createRecoveryState();
    recordToolResult(state, {
      toolName: "edit",
      input: { path: "file.ts", edits: [] },
      isError: true,
      content: errorText,
    });

    const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

    assert.ok(guidance.includes(location), guidance);
    assert.match(guidance, new RegExp(`missing required ${field}`));
    assert.match(guidance, /do not invent/i);
  }
});

test("buildRecoveryGuidance keeps generic guidance for unrelated edit schema failures", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "edit",
    input: { path: "file.ts" },
    isError: true,
    content: "Validation failed for tool \"edit\": path is required",
  });

  const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

  assert.match(guidance, /inspect the failure/i);
  assert.doesNotMatch(guidance, /missing required (?:oldText|newText)/i);
});

test("buildRecoveryGuidance asks for fresh context for duplicate text wording", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "edit",
    input: { path: "file.ts", edits: [{ oldText: "x", newText: "y" }] },
    isError: true,
    content: "Found 2 occurrences of the text in file.ts. The text must be unique.",
  });

  const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

  assert.match(guidance, /read a fresh snippet, then retry with exact oldText/i);
  assert.doesNotMatch(guidance, /choose|occurrence 1|occurrence 2/i);
});

test("buildRecoveryGuidance targets bash when read receives bash-shaped args", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "read",
    input: { command: "rg pattern", timeout: 30 },
    isError: true,
    content: "Validation failed for tool \"read\": path is required",
  });

  const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

  assert.match(guidance, /retry with bash/i);
  assert.match(guidance, /retry with bash instead of read/i);
});

test("buildRecoveryGuidance targets bash when write lacks required fields", () => {
  const state = createRecoveryState();
  recordToolResult(state, {
    toolName: "write",
    input: { command: "printf x", timeout: 30 },
    isError: true,
    content: "Validation failed for tool \"write\": path and content are required",
  });

  const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

  assert.match(guidance, /retry with bash/i);
});

test("buildRecoveryGuidance keeps generic guidance for unrelated read/write failures", () => {
  for (const [toolName, input] of [
    ["read", { path: "a.ts", command: "rg pattern" }],
    ["write", { path: "a.ts", content: "x", timeout: 30 }],
    ["read", { offset: 1 }],
    ["write", { content: "x" }],
    ["read", { timeout: 30 }],
    ["write", { path: "a.ts", timeout: 30 }],
  ] as const) {
    const state = createRecoveryState();
    recordToolResult(state, {
      toolName,
      input,
      isError: true,
      content: "Validation failed: unexpected field",
    });

    const guidance = buildRecoveryGuidance(state)[0]?.content ?? "";

    assert.doesNotMatch(guidance, /retry with bash/i);
    assert.match(guidance, /fix argument shape/i);
  }
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
