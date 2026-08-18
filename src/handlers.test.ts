import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyRepairedInput, handleContext, handleSessionStart, handleToolCall, handleToolResult, repairStatusText } from "./handlers.ts";
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

test("handleToolResult recovers a read offset past EOF", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-offset-"));
  await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree");
  const runtime = createRuntime();
  const event = {
    toolName: "read", input: { path: "notes.txt", offset: 5, limit: 2 }, isError: true,
    content: [{ type: "text", text: "Offset 5 is beyond end of file (3 lines total)" }], details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result?.isError, false);
  assert.match((result?.content?.[0] as { text: string }).text, /two\nthree$/);
  assert.equal(runtime.recovery.failures.length, 0);
  assert.equal(runtime.stats.failedToolResults, 0);
  assert.equal(runtime.stats.repairsByAction.get("read-offset-context"), 1);
});

test("handleToolResult converts a verified no-op edit into success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-noop-"));
  await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree");
  const runtime = createRuntime();
  const event = {
    toolName: "edit",
    input: { path: "notes.txt", edits: [{ oldText: "two", newText: "two" }] },
    isError: true,
    content: [{ type: "text", text: "No changes made. The replacement produced identical content." }],
    details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result?.isError, false);
  assert.equal(runtime.recovery.failures.length, 0);
  assert.equal(runtime.stats.repairsByAction.get("edit-noop"), 1);
});

test("handleToolResult keeps no-op edit failure when its repair is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-noop-"));
  await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree");
  const runtime = createRuntime();
  runtime.disabledRepairs = new Set(["edit-noop"]);
  const event = {
    toolName: "edit",
    input: { path: "notes.txt", edits: [{ oldText: "two", newText: "two" }] },
    isError: true,
    content: [{ type: "text", text: "No changes made. The replacement produced identical content." }],
    details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result, undefined);
  assert.equal(runtime.recovery.failures.length, 1);
});

test("handleToolResult enriches ENOENT with folder tree and keeps failure signal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-missing-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "actual.ts"), "x");
  const runtime = createRuntime();
  const event = {
    toolName: "read", input: { path: "src/missing.ts" }, isError: true,
    content: [{ type: "text", text: "ENOENT: no such file or directory" }], details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result?.isError, true);
  assert.match((result?.content?.[0] as { text: string }).text, /actual\.ts/);
  assert.equal(runtime.recovery.failures.length, 1);
  assert.equal(runtime.stats.failedToolResults, 1);
  assert.equal(runtime.stats.failuresByTool.get("read"), 1);
  assert.equal(runtime.stats.repairsByAction.get("missing-read-context"), 1);
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

test("handleSessionStart preserves a configured repairs-off runtime", async () => {
  const runtime = createRuntime({ repairsEnabled: false });
  const statuses: (string | undefined)[] = [];

  await handleSessionStart(runtime, ctx({ hasUI: true, ui: { notify: () => {}, setStatus: (_: string, v?: string) => statuses.push(v) } }), 0);

  assert.equal(runtime.enabled, false);
  assert.equal(statuses[0], "🔧 welder: on (repairs off)");
});

test("handleToolCall skips per-name disabled repairs (parse-json)", async () => {
  const runtime = createRuntime();
  runtime.disabledRepairs = new Set(["parse-json"]);
  const event = { toolName: "bash", input: { options: '{"a":1}' } };

  await handleToolCall(runtime, event as any, ctx());

  assert.equal(event.input.options, '{"a":1}');
});

test("handleToolCall skips ambiguous-edit preflight when resolve-ambiguous-edit is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-"));
  const current = [
    "interface First {",
    "  fileBytes?: number;",
    "}",
    "",
    "interface Second {",
    "  fileBytes?: number;",
    "}",
    "",
    "interface AfterSecond {}",
    "",
  ].join("\n");
  await writeFile(path.join(root, "file.ts"), current);
  const ambiguous = "  fileBytes?: number;\n}";
  const edits = [
    { oldText: ambiguous, newText: "  fileBytes?: number;\n  candidateCount?: number;\n}" },
    { oldText: "  fileBytes?: number;\n}\n\ninterface AfterSecond", newText: "  fileBytes?: number;\n  candidateCount?: number;\n}\n\ninterface AfterSecond" },
  ];
  const runtime = createRuntime();
  runtime.disabledRepairs = new Set(["resolve-ambiguous-edit"]);
  const event = { toolName: "edit", input: { path: "file.ts", edits: edits.map((e) => ({ ...e })) } };

  await handleToolCall(runtime, event as any, ctx({ cwd: root }));

  assert.deepEqual(event.input.edits, edits);
});

test("handleToolResult skips disabled directory-read repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-"));
  await mkdir(path.join(root, "folder"));
  const runtime = createRuntime();
  runtime.disabledRepairs = new Set(["directory-read"]);
  const event = {
    toolName: "read", input: { path: root }, isError: true,
    content: [{ type: "text", text: "EISDIR" }], details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result, undefined);
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

test("handleToolResult passes edit mismatch failures through unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-handler-edit-context-"));
  await writeFile(path.join(root, "file.ts"), "function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n");
  const runtime = createRuntime();
  const event = {
    toolName: "edit", isError: true,
    input: { path: "file.ts", edits: [{ oldText: "  return 1;", newText: "  return 2;" }] },
    content: [{ type: "text", text: "Found 2 occurrences of edits[0] in file.ts. Each oldText must be unique." }],
    details: {},
  } as any;

  const result = await handleToolResult(runtime, event, ctx({ cwd: root }));

  assert.equal(result, undefined);
  assert.match(runtime.recovery.failures[0]?.errorText ?? "", /Found 2 occurrences/);
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
