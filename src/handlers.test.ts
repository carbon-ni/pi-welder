import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyRepairedInput, handleContext, handleToolCall, handleToolResult, modelRecoveryStatus, repairStatusText } from "./handlers.ts";
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

test("handleToolResult converts failed read of directory into listing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-"));
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "file.ts"), "x");
  const runtime = createRuntime();
  const event = {
    toolName: "read", input: { path: root }, isError: true,
    content: [{ type: "text", text: "EISDIR" }], details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result?.isError, false);
  assert.match((result?.content?.[0] as { text: string }).text, /file\.ts/);
  assert.match((result?.content?.[0] as { text: string }).text, /folder\//);
  assert.equal(runtime.recovery.failures.length, 0);
  assert.equal(runtime.stats.repairedToolCalls, 1);
  assert.equal(runtime.stats.repairsByAction.get("directory-read"), 1);
});

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

test("applyRepairedInput mutates original object in place", () => {
  const input = { stale: true, edits: { oldText: "a", newText: "b" } };

  applyRepairedInput(input, { edits: [{ oldText: "a", newText: "b" }] });

  assert.deepEqual(input, { edits: [{ oldText: "a", newText: "b" }] });
});

test("repairStatusText summarizes first repairs and remaining count", () => {
  assert.equal(
    repairStatusText("edit", [
      { field: "input.a", action: "clean-path" },
      { field: "input.b", action: "parse-json" },
      { field: "input.c", action: "wrap-array" },
    ]),
    "🔧 edit: clean-path, parse-json (+1)",
  );
});

test("modelRecoveryStatus exposes progress and terminal outcomes", () => {
  assert.equal(modelRecoveryStatus("requested", "pending"), "🔧 edit: reasoning…");
  assert.equal(modelRecoveryStatus("applied", "success"), "🔧 edit: recovered");
  assert.match(modelRecoveryStatus("validated", "rejected", "ambiguous"), /ambiguous/);
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

test("handleToolResult does not retry model after preflight already attempted", async () => {
  const runtime = createRuntime({ modelRecovery: { enabled: true, apiKey: "fake", model: "cheap/model", baseUrl: "https://invalid.test", minConfidence: 0.9 } });
  runtime.modelRecoveryPreflightAttempts.add("call-1");
  const event = { toolCallId: "call-1", toolName: "edit", input: { path: "file.ts", edits: [{ oldText: "x", newText: "y" }] }, isError: true, content: "oldText must match exactly" } as any;

  await handleToolResult(runtime, event, ctx());

  assert.equal(runtime.modelRecoveryPreflightAttempts.has("call-1"), false);
  assert.equal(runtime.recovery.failures.length, 1);
});

test("handleToolResult returns fresh file context when agent-mode edit recovery is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-edit-context-"));
  await writeFile(path.join(root, "file.ts"), "function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n");
  const runtime = createRuntime({ modelRecovery: { enabled: true, apiKey: "fake", model: "cheap/model", baseUrl: "https://invalid.test", minConfidence: 0.9 } });
  runtime.modelRecoveryPreflightAttempts.add("call-1");
  const event = {
    toolCallId: "call-1", toolName: "edit", isError: true,
    input: { path: "file.ts", edits: [{ oldText: "  return 1;", newText: "  return 2;" }] },
    content: "Found 2 occurrences of edits[0] in file.ts. Each oldText must be unique.",
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result?.isError, true);
  assert.match(String(result?.content[0]?.text), /Current context edits\[0\]/);
  assert.match(String(result?.content[0]?.text), /function first/);
  assert.doesNotMatch(String(result?.content[0]?.text), /call read|read only/i);
  assert.match(runtime.recovery.failures[0]?.errorText ?? "", /Current context edits\[0\]/);
});

test("handleToolCall records repair warnings in runtime", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } };

  await handleToolCall(runtime, event as any, ctx());

  assert.equal(runtime.repairWarnings.warnings.length, 1);
  assert.equal(runtime.repairWarnings.warnings[0]?.toolName, "edit");
});

test("handleContext injects repair warnings alongside recovery guidance", async () => {
  const runtime = createRuntime();

  // Trigger a repair
  await handleToolCall(
    runtime,
    { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } } as any,
    ctx(),
  );

  // Trigger a failure
  await handleToolResult(
    runtime,
    { toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT" } as any,
    ctx(),
  );

  const out = await handleContext(runtime, { messages: [{ role: "user", content: "retry" }] } as any);

  // Original + recovery + repair warnings = 3 messages
  assert.equal(out?.messages.length, 3);

  const recovery = out?.messages[1] as { content?: string };
  const warnings = out?.messages[2] as { content?: string };
  assert.match(String(recovery?.content), /pi-welder recovery hints/);
  assert.match(String(warnings?.content), /pi-welder repair hints/);
  assert.match(String(warnings?.content), /wrap-object-array/);
});

test("handleToolCall does NOT record warnings when repairs are empty", async () => {
  const runtime = createRuntime();
  const event = { toolName: "read", input: { path: "a.ts" } };

  await handleToolCall(runtime, event as any, ctx());

  assert.equal(runtime.repairWarnings.warnings.length, 0);
});

test("handleToolCall does NOT record warnings when disabled", async () => {
  const runtime = createRuntime();
  runtime.enabled = false;
  const event = { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } };

  await handleToolCall(runtime, event as any, ctx());

  assert.equal(runtime.repairWarnings.warnings.length, 0);
});

test("handleContext deduplicates repair warnings", async () => {
  const runtime = createRuntime();

  await handleToolCall(
    runtime,
    { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } } as any,
    ctx(),
  );

  const first = await handleContext(runtime, { messages: [{ role: "user", content: "retry" }] } as any);
  const second = await handleContext(runtime, { messages: [{ role: "user", content: "retry again" }] } as any);

  // First call injects warnings, second does not (dedup)
  assert.equal(first?.messages.length, 2);
  assert.equal(second, undefined);
});

test("handleContext returns undefined when nothing to inject", async () => {
  const runtime = createRuntime();

  const out = await handleContext(runtime, { messages: [{ role: "user", content: "retry" }] } as any);

  assert.equal(out, undefined);
});
