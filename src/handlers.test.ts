import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyRepairedInput, handleContext, handleSessionShutdown, handleSessionStart, handleToolCall, handleToolResult, repairStatusText } from "./handlers.ts";
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
  assert.equal(runtime.stats.recoveriesByAction.get("directory-read"), 1);
  assert.equal(runtime.stats.repairedToolCalls, 0, "a result patch is a recovery, not an input repair");
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
  assert.equal(runtime.stats.recoveriesByAction.get("read-offset-context"), 1);
  assert.equal(runtime.stats.repairedToolCalls, 0, "a result patch is a recovery, not an input repair");
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
  assert.equal(runtime.stats.recoveriesByAction.get("edit-noop"), 1);
  assert.equal(runtime.stats.recoveredResults, 1);
  assert.equal(runtime.stats.repairedToolCalls, 0, "a result patch is not an input repair");
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
  assert.equal(runtime.stats.enrichmentsByAction.get("missing-read-context"), 1);
  assert.equal(runtime.stats.enrichedResults, 1);
  assert.equal(runtime.stats.repairedToolCalls, 0, "diagnostic enrichment is never a repair");
  assert.equal(runtime.stats.repairsByAction.size, 0);
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

test("handleToolCall blocks a read-shaped edit and returns the exact corrected read call", async () => {
  const runtime = createRuntime();
  // cwd and path deliberately do not exist: no filesystem pre-read may happen.
  const event = { toolName: "edit", toolCallId: "c1", input: { path: "missing/a.ts", offset: 3, limit: 2 } };

  const outcome = await handleToolCall(runtime, event as any, ctx({ cwd: "/nonexistent-root" }));

  assert.ok(outcome);
  assert.equal(outcome.block, true);
  assert.match(outcome.reason, /blocked this edit/);
  assert.match(outcome.reason, /no edit was applied/);
  assert.match(outcome.reason, /\{"name":"read","arguments":\{"path":"missing\/a\.ts","offset":3,"limit":2\}\}/);
  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), 1);
  assert.equal(runtime.stats.totalToolCalls, 1);
  assert.deepEqual(event.input, { path: "missing/a.ts", offset: 3, limit: 2 });
});

test("handleToolCall converts a startLine/endLine read shape deterministically", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", toolCallId: "c2", input: { path: "src/a.ts", startLine: 10, endLine: 20 } };

  const outcome = await handleToolCall(runtime, event as any, ctx());

  assert.ok(outcome);
  assert.match(outcome.reason, /"offset":10,"limit":11/);
  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), 1);
});

test("the block result exposes only Pi's supported blocking fields (host-capability fallback)", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", toolCallId: "c3", input: { path: "a.ts" } };

  const outcome = await handleToolCall(runtime, event as any, ctx());

  // Pi 0.85.0 ToolCallEventResult is { block?: boolean; reason?: string }.
  // No tool-identity replacement exists, so blocking plus an exact corrected
  // call in the reason is the strongest supported behavior.
  assert.deepEqual(Object.keys(outcome!).sort(), ["block", "reason"]);
  assert.equal(outcome!.block, true);
  assert.equal(typeof outcome!.reason, "string");
});

test("handleToolCall applies no restore-read-shape action to mixed, unknown-field, invalid-range, or content-bearing calls", async () => {
  const cases = [
    { path: "a.ts", edits: [{ oldText: "a", newText: "b" }], offset: 3 },
    { path: "a.ts", oldText: "a", newText: "b" },
    { path: "a.ts", offset: 3, verbose: true },
    { path: "a.ts", offset: 3, startLine: 3, endLine: 9 },
    { path: "a.ts", offset: 0 },
    { path: "a.ts", startLine: 5, endLine: 4 },
    { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
  ];

  for (const input of cases) {
    const runtime = createRuntime();
    const outcome = await handleToolCall(runtime, { toolName: "edit", toolCallId: "c", input } as any, ctx());
    assert.equal(outcome, undefined, JSON.stringify(input));
    assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), undefined, JSON.stringify(input));
  }
});

test("restore-read-shape rejection leaves existing independent repairs eligible (nest-edit-fields regression)", async () => {
  // Direct oldText/newText is content-bearing for the restoration and must
  // still be repaired by nest-edit-fields exactly as before TASK-0028.
  const runtime = createRuntime();
  const event = { toolName: "edit", toolCallId: "c", input: { path: "a.ts", oldText: "x", newText: "y" } };

  const outcome = await handleToolCall(runtime, event as any, ctx());

  assert.equal(outcome, undefined, "restoration must not block a repairable edit");
  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), undefined);
  assert.equal(runtime.stats.repairsByAction.get("nest-edit-fields"), 1);
  assert.deepEqual(event.input, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
});

test("restore-read-shape rejection still routes mixed shapes through independent repairs", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", toolCallId: "c", input: { path: "a.ts", offset: 3, edits: [{ oldText: "a", newText: "b" }] } };

  await handleToolCall(runtime, event as any, ctx());

  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), undefined);
  // The call flowed through repairArgs (existing behavior), not suppressed.
  assert.equal(runtime.stats.totalToolCalls, 1);
  assert.equal(runtime.stats.repairsByAction.get("relational-default"), 1);
});

test("restore-read-shape recognition runs before repairArgs, so recognized calls are not arg-mutated", async () => {
  const runtime = createRuntime();
  const event = { toolName: "edit", toolCallId: "c", input: { path: "a.ts", offset: 3 } };

  const outcome = await handleToolCall(runtime, event as any, ctx());

  assert.ok(outcome?.block);
  // repairArgs would have injected a default limit; recognition must precede it.
  assert.equal(runtime.stats.repairsByAction.get("relational-default"), undefined);
  assert.deepEqual(event.input, { path: "a.ts", offset: 3 });
});

test("handleToolCall does not block read-shaped input on non-edit tools", async () => {
  const runtime = createRuntime();
  const outcome = await handleToolCall(runtime, { toolName: "read", toolCallId: "c", input: { path: "a.ts", offset: 3 } } as any, ctx());
  assert.equal(outcome, undefined);
  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), undefined);
});

test("handleToolCall skips read-shape restoration when restore-read-shape is disabled", async () => {
  const runtime = createRuntime();
  runtime.disabledRepairs = new Set(["restore-read-shape"]);
  const event = { toolName: "edit", toolCallId: "c", input: { path: "a.ts", offset: 3, limit: 2 } };

  const outcome = await handleToolCall(runtime, event as any, ctx());

  assert.equal(outcome, undefined);
  assert.equal(runtime.stats.repairsByAction.get("restore-read-shape"), undefined);
  assert.deepEqual(event.input, { path: "a.ts", offset: 3, limit: 2 });
});

test("handleToolCall skips read-shape restoration when repairs are off", async () => {
  const runtime = createRuntime({ repairsEnabled: false });
  const outcome = await handleToolCall(runtime, { toolName: "edit", toolCallId: "c", input: { path: "a.ts", offset: 3 } } as any, ctx());
  assert.equal(outcome, undefined);
});

test("read-path repair is off by default and independent of source shadowing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await writeFile(path.join(root, "config.ts"), "x");
  const client = { choose: async () => { throw new Error("must not be called"); } };
  const runtime = createRuntime({ sourceShadowingEnabled: true, readPathClient: client as any });
  const event = { toolName: "read", toolCallId: "c", input: { path: "confg.ts" } };

  await handleToolCall(runtime, event as any, ctx({ cwd: root }));

  assert.equal(runtime.readPathState.eligible, 0, "source-shadow consent must not enable path repair");
  assert.deepEqual(event.input, { path: "confg.ts" });
});

test("read-path repair runs when enabled with a client: no hidden runtime gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await writeFile(path.join(root, "config.ts"), "x");
  let calls = 0;
  const client = { choose: async () => { calls++; return { choice: 1, confidence: 0.99 }; } };
  // The explicit setting plus an available client mean mutation is enabled.
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathClient: client as any });
  const event = { toolName: "read", toolCallId: "c", input: { path: "confg.ts" } };

  await handleToolCall(runtime, event as any, ctx({ cwd: root }));

  assert.equal(runtime.readPathState.eligible, 1);
  assert.equal(calls, 1, "one bounded request");
  assert.equal(event.input.path, "config.ts", "the validated path is applied");
  assert.equal(runtime.stats.repairsByAction.get("restore-read-path"), 1);
});

test("read-path repair mutates read.path exactly when the selection is validated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "config.ts"), "x");
  let calls = 0;
  const client = { choose: async () => { calls++; return { choice: 1, confidence: 0.99, model: "jev" }; } };
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathClient: client as any });
  const event = { toolName: "read", toolCallId: "c", input: { path: "src/confg.ts", limit: 10 } };

  await handleToolCall(runtime, event as any, ctx({ cwd: root }));

  assert.equal(calls, 1, "one bounded request, zero retries");
  assert.equal(runtime.stats.repairsByAction.get("restore-read-path"), 1);
  assert.equal(event.input.path, "src/config.ts", "only path is mutated");
  assert.equal(event.input.limit, 10, "other fields untouched");
  assert.equal(runtime.readPathState.selected, 1);
});

test("read-path repair leaves the call unchanged on abstain, low confidence, failure, and invalid selections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "config.ts"), "x");

  const scenarios: (() => Promise<unknown>)[] = [
    async () => ({ choice: null, confidence: 0.5 }),
    async () => ({ choice: 1, confidence: 0.4 }),
    async () => ({ choice: 9, confidence: 0.99 }),
    async () => { throw Object.assign(new Error("429"), { kind: "rate-limited" }); },
    async () => { throw new Error("boom"); },
  ];

  for (const choose of scenarios) {
    const runtime = createRuntime({ readPathRepairEnabled: true, readPathClient: { choose } as any });
    const event = { toolName: "read", toolCallId: "c", input: { path: "src/confg.ts" } };
    await handleToolCall(runtime, event as any, ctx({ cwd: root }));
    assert.deepEqual(event.input, { path: "src/confg.ts" });
    assert.equal(runtime.stats.repairsByAction.get("restore-read-path"), undefined);
  }
});

test("read-path repair never mutates non-read tools or eligibility-failing reads", async () => {
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathClient: { choose: async () => ({ choice: 1, confidence: 0.99 }) } as any });
  const editEvent = { toolName: "edit", toolCallId: "c", input: { path: "src/confg.ts" } };
  await handleToolCall(runtime, editEvent as any, ctx());
  assert.deepEqual(editEvent.input, { path: "src/confg.ts" });

  const existing = { toolName: "read", toolCallId: "c2", input: { path: "package.json" } };
  await handleToolCall(runtime, existing as any, ctx({ cwd: process.cwd() }));
  assert.deepEqual(existing.input, { path: "package.json" }, "existing file is not eligible");
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

test("handleContext does not inject generic recovery guidance", async () => {
  const runtime = createRuntime();
  await handleToolResult(
    runtime,
    { toolName: "edit", input: { path: "a.ts" }, isError: true, content: "EDIT_MISMATCH: oldText not found" } as any,
    ctx(),
  );

  const out = await handleContext(runtime, { messages: [{ role: "user", content: "retry" }] } as any);

  assert.equal(out, undefined);
  assert.equal(runtime.recovery.failures.length, 1);
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

test("handleContext injects repair warnings without generic recovery guidance", async () => {
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

  // Original + repair warnings; generic recovery guidance is not injected.
  assert.equal(out?.messages.length, 2);

  const warnings = out?.messages[1] as { content?: string };
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

test("handleToolCall shadows ambiguous edits without blocking or mutating input", async () => {
  // Distinct neighborhoods around each occurrence give preflight two
  // non-overlapping unique expansions, so it abstains and shadow is eligible.
  const content = "return value; // first\nmid\n// last return value;";
  const root = await mkdtemp(path.join(tmpdir(), "welder-shadow-"));
  await writeFile(path.join(root, "a.ts"), content);
  const calls: unknown[] = [];
  const evidence: any[] = [];
  const runtime = createRuntime({
    sourceShadowingEnabled: true,
    jevClient: { choose: async (request) => { calls.push(request); return { choice: 2, confidence: 0.99, model: "jev-test" }; } },
  });
  await handleSessionStart(runtime, ctx({ cwd: root }));
  runtime.onShadowEvidence = (record) => evidence.push(record);

  const input = { path: "a.ts", edits: [{ oldText: "return value;", newText: "return nextValue;" }] };
  const started = Date.now();
  await handleToolCall(runtime, { toolName: "edit", toolCallId: "c1", input } as any, ctx({ cwd: root }));
  assert.ok(Date.now() - started < 100, "shadow must not block the tool call");
  assert.deepEqual(input, { path: "a.ts", edits: [{ oldText: "return value;", newText: "return nextValue;" }] });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await runtime.jevShadow!.drain();

  assert.equal(calls.length, 1);
  assert.equal(runtime.jevShadow!.inFlight, 0);
  assert.equal(evidence[0]?.status, "selected");
  assert.equal(evidence[0]?.selectedOrdinal, 2);

  await handleSessionShutdown(runtime, ctx({ cwd: root }));
});

test("handleToolCall makes no shadow request for unique edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-shadow-unique-"));
  await writeFile(path.join(root, "a.ts"), "return value;\n");
  const calls: unknown[] = [];
  const runtime = createRuntime({
    sourceShadowingEnabled: true,
    jevClient: { choose: async (request) => { calls.push(request); return { choice: null, confidence: 1 }; } },
  });
  await handleSessionStart(runtime, ctx({ cwd: root }));

  await handleToolCall(runtime, { toolName: "edit", toolCallId: "c1", input: { path: "a.ts", edits: [{ oldText: "return value;", newText: "x" }] } } as any, ctx({ cwd: root }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);

  await handleToolCall(runtime, { toolName: "read", toolCallId: "c2", input: { path: "a.ts" } } as any, ctx({ cwd: root }));
  assert.equal(calls.length, 0);
});

test("shadow is inactive without a client even when the setting is on", async () => {
  const runtime = createRuntime({ sourceShadowingEnabled: true });
  await handleSessionStart(runtime, ctx());
  assert.equal(runtime.jevShadow, undefined);
});

test("handleToolResult correlation labels a later successful edit", async () => {
  const evidence: any[] = [];
  const runtime = createRuntime({
    sourceShadowingEnabled: true,
    jevClient: { choose: async () => ({ choice: 2, confidence: 0.99, model: "jev-test" }) },
  });
  await handleSessionStart(runtime, ctx());
  runtime.onShadowEvidence = (record) => evidence.push(record);
  const shadow = runtime.jevShadow!;
  shadow.submit({
    toolCallId: "c1",
    path: "src/a.ts",
    candidates: [
      { ordinal: 1, window: "first candidate body" },
      { ordinal: 2, window: "second candidate body" },
    ],
    requestedEditText: "x",
  });
  await new Promise((resolve) => setImmediate(resolve));

  await handleToolCall(runtime, { toolName: "edit", toolCallId: "c2", input: { path: "src/a.ts", edits: [{ oldText: "second candidate body", newText: "y" }] } } as any, ctx());
  await handleToolResult(runtime, { toolName: "edit", toolCallId: "c2", input: {}, isError: false } as any, ctx());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(evidence.length, 2);
  assert.equal(evidence[1]?.labelStatus, "provisional-correct");
  for (const record of evidence) {
    const json = JSON.stringify(record);
    assert.doesNotMatch(json, /candidate body|src\/a\.ts/);
  }
});

test("handleToolCall makes no shadow request when resolve-ambiguous-edit is disabled", async () => {
  const content = "return value; // first\nmid\n// last return value;";
  const root = await mkdtemp(path.join(tmpdir(), "welder-shadow-disabled-"));
  await writeFile(path.join(root, "a.ts"), content);
  const calls: unknown[] = [];
  const runtime = createRuntime({
    sourceShadowingEnabled: true,
    jevClient: { choose: async (request) => { calls.push(request); return { choice: null, confidence: 1 }; } },
  });
  runtime.disabledRepairs = new Set(["resolve-ambiguous-edit"]);
  await handleSessionStart(runtime, ctx({ cwd: root }));

  await handleToolCall(runtime, { toolName: "edit", toolCallId: "c1", input: { path: "a.ts", edits: [{ oldText: "return value;", newText: "x" }] } } as any, ctx({ cwd: root }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0);
});

test("persisted shadow JSONL events contain no source, paths, or edit text", async () => {
  const content = "return value; // first\nmid\n// last return value;";
  const root = await mkdtemp(path.join(tmpdir(), "welder-shadow-jsonl-"));
  await writeFile(path.join(root, "a.ts"), content);
  const runtime = createRuntime({
    sourceShadowingEnabled: true,
    jevClient: { choose: async () => ({ choice: 2, confidence: 0.99, model: "jev-test" }) },
  });
  await handleSessionStart(runtime, ctx({ cwd: root }));

  await handleToolCall(runtime, { toolName: "edit", toolCallId: "c1", input: { path: "a.ts", edits: [{ oldText: "return value;", newText: "return nextValue; secret" }] } } as any, ctx({ cwd: root }));
  await runtime.jevShadow!.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { readFile } = await import("node:fs/promises");
  const logPath = path.join(root, ".pi", "welder-log", "handlers-test.jsonl");
  const raw = await readFile(logPath, "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  const shadowEvents = events.filter((event) => event.eventType === "shadow");
  assert.ok(shadowEvents.length >= 1);
  for (const event of shadowEvents) {
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /return value|nextValue|a\.ts|secret/);
    assert.deepEqual(
      Object.keys(event).filter((key) => !["ts", "eventType", "toolName", "provider", "model", "repairs", "wasRepaired", "inputKeys"].includes(key)).sort(),
      ["candidateCount", "confidence", "decisionModel", "labelStatus", "latencyMs", "outcome", "selectedOrdinal", "toolCallId"].sort(),
    );
  }
});

// --- TASK-0034 (redesign): same-name wrapper, prepare -> validate -> execute -

import { mkdtemp as mkdtempRoute, readFile as readFileRoute } from "node:fs/promises";
import { createRequire } from "node:module";
import { createBashTool, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashRouteState, sentinelTokenOf, wrapToolForBashRouting, type BashDelegate, type RouteToolName, type ToolLike } from "./command-routing/wrapper.ts";

/** Pi's own validator, resolved through the SDK's public export map. */
async function piValidateToolArguments(tool: unknown, toolCall: { name: string; id: string; arguments: unknown }): Promise<unknown> {
  const parent = import.meta.resolve("@earendil-works/pi-coding-agent");
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", parent)) as { validateToolArguments: (tool: unknown, call: unknown) => unknown };
  return ai.validateToolArguments(tool, toolCall);
}

function resolveBuiltinFor(toolName: RouteToolName) {
  return (cwd: string): ToolLike => {
    if (toolName === "write") return createWriteToolDefinition(cwd) as unknown as ToolLike;
    return createReadToolDefinition(cwd) as unknown as ToolLike;
  };
}

const realBashDelegate: BashDelegate = async ({ command, timeout, cwd, signal, toolCallId }) => {
  const tool = createBashTool(cwd);
  const result = await tool.execute(toolCallId, { command, ...(timeout === undefined ? {} : { timeout }) }, signal);
  return { content: result.content, details: result.details, isError: false };
};

test("lifecycle: prepare -> native validation -> execute routes write(command,timeout) to bash exactly once", async () => {
  const root = await mkdtempRoute(path.join(tmpdir(), "welder-route-lifecycle-"));
  const marker = path.join(root, "counter.txt");
  const routeState = createBashRouteState({ isEnabled: () => true, isTrusted: () => true });
  const wrapper = wrapToolForBashRouting({
    builtin: createWriteToolDefinition(root) as unknown as ToolLike,
    toolName: "write",
    state: routeState,
    delegate: realBashDelegate,
    resolveBuiltin: resolveBuiltinFor("write"),
    nextToken: () => "opaque-token-1",
  });
  const toolCall = { name: "write", id: "call-lifecycle-1", arguments: { command: `printf hello && printf x >> ${marker}`, timeout: 20 } };

  // 1. prepareArguments swaps the bash shape for a source-schema-valid sentinel.
  const prepared = wrapper.prepareArguments!(toolCall.arguments) as Record<string, unknown>;
  assert.equal(sentinelTokenOf(prepared), "opaque-token-1");
  assert.equal(JSON.stringify(prepared).includes("printf"), false, "the sentinel never carries the command");

  // 2. Pi's own validator accepts the sentinel against the strict write schema.
  const validated = await piValidateToolArguments({ name: "write", parameters: wrapper.parameters, execute: wrapper.execute }, { ...toolCall, arguments: prepared });
  assert.deepEqual(validated, prepared);

  // 3. execute reaches the real bash tool once and returns a non-error success.
  const result: any = await wrapper.execute(toolCall.id, validated, undefined, undefined, { cwd: root, isProjectTrusted: () => true });
  assert.equal(result.isError === true, false, "a successful route is not an error result");
  assert.match(result.content[0].text, /hello/);
  assert.equal(await readFileRoute(marker, "utf8"), "x", "the command ran exactly once");
  assert.equal(routeState.tokens.size, 0, "the token is consumed");
});

test("lifecycle: disabled stays on native validation and never executes", async () => {
  const root = await mkdtempRoute(path.join(tmpdir(), "welder-route-disabled-"));
  const marker = path.join(root, "counter.txt");
  const routeState = createBashRouteState({ isEnabled: () => false, isTrusted: () => true });
  let bashCalls = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: createWriteToolDefinition(root) as unknown as ToolLike,
    toolName: "write",
    state: routeState,
    delegate: async () => { bashCalls++; return { content: [] }; },
    resolveBuiltin: resolveBuiltinFor("write"),
    nextToken: () => "opaque-token-1",
  });
  const raw = { command: `printf x >> ${marker}`, timeout: 20 };

  const prepared = wrapper.prepareArguments!(raw);
  assert.deepEqual(prepared, raw, "args are left unchanged for native validation");
  await assert.rejects(
    () => piValidateToolArguments({ name: "write", parameters: wrapper.parameters, execute: wrapper.execute }, { name: "write", id: "c", arguments: prepared }),
    /Validation failed for tool "write"/,
  );
  assert.equal(bashCalls, 0);
  await assert.rejects(() => readFileRoute(marker, "utf8"), "nothing executed");
});

test("lifecycle: untrusted project stays on native validation and never executes", async () => {
  const root = await mkdtempRoute(path.join(tmpdir(), "welder-route-untrusted-"));
  const marker = path.join(root, "counter.txt");
  const routeState = createBashRouteState({ isEnabled: () => true, isTrusted: () => false });
  let bashCalls = 0;
  const wrapper = wrapToolForBashRouting({
    builtin: createWriteToolDefinition(root) as unknown as ToolLike,
    toolName: "write",
    state: routeState,
    delegate: async () => { bashCalls++; return { content: [] }; },
    resolveBuiltin: resolveBuiltinFor("write"),
    nextToken: () => "opaque-token-1",
  });
  const raw = { command: `printf x >> ${marker}`, timeout: 20 };

  const prepared = wrapper.prepareArguments!(raw);
  assert.deepEqual(prepared, raw);
  await assert.rejects(
    () => piValidateToolArguments({ name: "write", parameters: wrapper.parameters, execute: wrapper.execute }, { name: "write", id: "c", arguments: prepared }),
    /Validation failed for tool "write"/,
  );
  assert.equal(bashCalls, 0);
  await assert.rejects(() => readFileRoute(marker, "utf8"));
});

test("handleToolCall leaves a routed sentinel untouched and handleToolResult passes the bash result through", async () => {
  const runtime = createRuntime({ commandReroutingEnabled: true });
  const sentinel = { path: "pi-welder-route:opaque-token-1", content: "" };

  const outcome = await handleToolCall(runtime, { toolName: "write", toolCallId: "s1", input: { ...sentinel } } as any, ctx());
  assert.equal(outcome, undefined, "welder repairs never touch a sentinel");
  assert.equal(runtime.stats.repairsByAction.get("route-to-bash"), undefined);
  assert.equal(runtime.stats.totalToolCalls, 0);

  const patched = await handleToolResult(runtime, { toolName: "write", toolCallId: "s1", input: { ...sentinel }, isError: false, content: [{ type: "text", text: "bash output" }] } as any, ctx());
  assert.equal(patched, undefined, "the real bash result passes through unchanged");
});

test("session shutdown clears the bash route token state", async () => {
  const runtime = createRuntime({ commandReroutingEnabled: true });
  runtime.bashRouteState.tokens.set("tok", { sourceTool: "write", epoch: 0, command: "echo hi" });

  await handleSessionShutdown(runtime, ctx());

  assert.equal(runtime.bashRouteState.tokens.size, 0);
});

test("a routed sentinel result still closes episode bookkeeping and records failures", async () => {
  const runtime = createRuntime({ commandReroutingEnabled: true });
  const sentinel = { path: "pi-welder-route:opaque-token-1", content: "" };

  await handleToolCall(runtime, { toolName: "write", toolCallId: "route-acc-1", input: { ...sentinel } } as any, ctx());

  const result = await handleToolResult(
    runtime,
    { toolName: "write", toolCallId: "route-acc-1", input: { ...sentinel }, isError: true, content: [{ type: "text", text: "Command exited with code 3" }] } as any,
    ctx(),
  );

  assert.equal(result, undefined, "no result patch for a routed call");
  assert.equal(runtime.stats.failedToolResults, 1, "the routed failure is recorded through normal accounting");
  assert.equal(runtime.stats.repairsByAction.get("route-to-bash"), undefined, "no repair rewriting on the routed result");
});
