import { test } from "node:test";
import assert from "node:assert/strict";

import { handleContext, handleToolCall, handleToolResult } from "./handlers.ts";
import { createRuntime } from "./runtime.ts";

function ctx(overrides: Partial<any> = {}): any {
  return {
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "handlers-test" },
    model: { provider: "test-provider", id: "test-model" },
    ui: { notify: () => {}, setStatus: () => {} },
    ...overrides,
  };
}

test("handleToolCall repairs input through explicit runtime", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } };

  await handleToolCall(runtime, event as any, ctx());

  assert.deepEqual(event.input.edits, [{ oldText: "a", newText: "b" }]);
  assert.equal(runtime.stats.totalToolCalls, 1);
  assert.equal(runtime.stats.repairedToolCalls, 1);
});

test("handleToolCall tracks repairs without mutating input when disabled", async () => {
  const runtime = createRuntime();
  runtime.enabled = false;
  const event = { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } };

  await handleToolCall(runtime, event as any, ctx());

  assert.deepEqual(event.input.edits, { oldText: "a", newText: "b" });
  assert.equal(runtime.stats.totalToolCalls, 1);
  assert.equal(runtime.stats.repairedToolCalls, 1);
});

test("handleContext injects recovery guidance through explicit runtime", async () => {
  const runtime = createRuntime();
  await handleToolResult(
    runtime,
    { toolName: "edit", input: { path: "a.ts" }, isError: true, content: "EDIT_MISMATCH: oldText not found" } as any,
    ctx(),
  );

  const out = await handleContext(runtime, { messages: [{ role: "user", content: "retry" }] } as any);

  const guidance = out?.messages[1] as { content?: unknown } | undefined;
  assert.equal(out?.messages.length, 2);
  assert.match(String(guidance?.content), /read a fresh snippet/);
});
