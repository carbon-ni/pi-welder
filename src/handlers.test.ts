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

test("read-path repair with the gate unmet is shadow-only: eligibility counted, no API call, no mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await writeFile(path.join(root, "config.ts"), "x");
  let calls = 0;
  const client = { choose: async () => { calls++; return { choice: 1, confidence: 0.99 }; } };
  // readPathMutationEnabled defaults to the frozen gate verdict (false).
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathClient: client as any });
  const event = { toolName: "read", toolCallId: "c", input: { path: "confg.ts" } };

  await handleToolCall(runtime, event as any, ctx({ cwd: root }));

  assert.equal(runtime.readPathState.eligible, 1);
  assert.equal(calls, 0, "gate unmet: no API call");
  assert.deepEqual(event.input, { path: "confg.ts" }, "gate unmet: no mutation");
  assert.equal(runtime.stats.repairsByAction.get("restore-read-path"), undefined);
});

test("read-path repair mutates read.path exactly when the gate is met and the selection is validated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "config.ts"), "x");
  let calls = 0;
  const client = { choose: async () => { calls++; return { choice: 1, confidence: 0.99, model: "jev" }; } };
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathMutationEnabled: true, readPathClient: client as any });
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
    const runtime = createRuntime({ readPathRepairEnabled: true, readPathMutationEnabled: true, readPathClient: { choose } as any });
    const event = { toolName: "read", toolCallId: "c", input: { path: "src/confg.ts" } };
    await handleToolCall(runtime, event as any, ctx({ cwd: root }));
    assert.deepEqual(event.input, { path: "src/confg.ts" });
    assert.equal(runtime.stats.repairsByAction.get("restore-read-path"), undefined);
  }
});

test("read-path repair never mutates non-read tools or eligibility-failing reads", async () => {
  const runtime = createRuntime({ readPathRepairEnabled: true, readPathMutationEnabled: true, readPathClient: { choose: async () => ({ choice: 1, confidence: 0.99 }) } as any });
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

// --- TASK-0034: exact bash-shaped wrong-tool execution ---------------------

interface RecordedBashCall { toolCallId: string; command: string; timeout?: number; cwd: string; signal?: AbortSignal }

function routeRuntime(
  executor: { execute: (request: any) => Promise<any> },
  overrides: Parameters<typeof createRuntime>[0] = {},
) {
  return createRuntime({ commandReroutingEnabled: true, bashExecutor: executor as any, ...overrides });
}

function routeCtx(overrides: Partial<any> = {}): any {
  return ctx({ isProjectTrusted: () => true, ...overrides });
}

test("handleToolCall executes an exact bash-shaped write once and blocks it with the real output", async () => {
  const calls: RecordedBashCall[] = [];
  const runtime = routeRuntime({
    execute: async (request: RecordedBashCall) => {
      calls.push(request);
      return { text: "hello from bash", isError: false };
    },
  });
  const event = { toolName: "write", toolCallId: "route-1", input: { command: "ls -la", timeout: 30 } };

  const outcome = await handleToolCall(runtime, event as any, routeCtx({ cwd: "/tmp/project" }));

  assert.ok(outcome);
  assert.deepEqual(Object.keys(outcome!).sort(), ["block", "reason"], "only Pi's supported blocking fields");
  assert.equal(outcome!.block, true);
  assert.match(outcome!.reason, /blocked this write call/);
  assert.match(outcome!.reason, /hello from bash/);
  assert.equal(outcome!.reason.includes("ls -la"), false, "the command is never echoed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { toolCallId: "route-1", command: "ls -la", timeout: 30, cwd: "/tmp/project" });
  assert.equal(runtime.stats.repairsByAction.get("route-to-bash"), 1);
  assert.equal(runtime.pendingBashRoutes.has("route-1"), true);
});

test("the abort signal is forwarded and an absent timeout stays absent", async () => {
  const calls: RecordedBashCall[] = [];
  const runtime = routeRuntime({ execute: async (request: RecordedBashCall) => { calls.push(request); return { text: "ok", isError: false }; } });
  const controller = new AbortController();

  await handleToolCall(runtime, { toolName: "read", toolCallId: "signal-1", input: { command: "sleep 1" } } as any, routeCtx({ signal: controller.signal }));

  assert.equal(calls[0]!.signal, controller.signal, "the turn signal is preserved");
  assert.equal("timeout" in calls[0]!, false, "no invented timeout");
});

test("a failed command is reported as failed and never as success", async () => {
  const runtime = routeRuntime({
    execute: async () => ({ text: "boom\n\nCommand exited with code 2", isError: true }),
  });

  const outcome = await handleToolCall(runtime, { toolName: "read", toolCallId: "route-2", input: { command: "false" } } as any, routeCtx());

  assert.match(outcome!.reason, /ran once through bash and failed/);
  assert.match(outcome!.reason, /Command exited with code 2/);
});

test("an executor rejection fails closed: the original call is not blocked", async () => {
  let calls = 0;
  const runtime = routeRuntime({ execute: async () => { calls++; throw new Error("executor exploded"); } });

  const outcome = await handleToolCall(runtime, { toolName: "edit", toolCallId: "route-3", input: { command: "echo hi" } } as any, routeCtx());

  assert.equal(outcome, undefined, "no claim of success when the executor fails");
  assert.equal(calls, 1);
  assert.equal(runtime.pendingBashRoutes.size, 0);
});

test("handleToolCall abstains unless every mandatory condition holds", async () => {
  const cases: { label: string; runtime: any; ctx: any; event: any }[] = [
    { label: "setting off", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }, { commandReroutingEnabled: false }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "repairs disabled", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }, { repairsEnabled: false }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "repair rule disabled", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }, { disabledRepairs: ["route-to-bash"] }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "untrusted project", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx({ isProjectTrusted: () => false }), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "missing trust callback", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: ctx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "no executor", runtime: createRuntime({ commandReroutingEnabled: true }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls" } } },
    { label: "attempted bash", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "bash", toolCallId: "c", input: { command: "ls" } } },
    { label: "unknown tool", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "ast_map", toolCallId: "c", input: { command: "ls" } } },
    { label: "extra field", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls", path: "a.ts" } } },
    { label: "invalid timeout", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "ls", timeout: -1 } } },
    { label: "empty command", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { command: "  " } } },
    { label: "valid write shape", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "write", toolCallId: "c", input: { path: "a.ts", content: "x" } } },
    { label: "missing call id", runtime: routeRuntime({ execute: async () => ({ text: "x", isError: false }) }), ctx: routeCtx(), event: { toolName: "write", input: { command: "ls" } } },
  ];

  for (const entry of cases) {
    const outcome = await handleToolCall(entry.runtime, entry.event as any, entry.ctx);
    assert.equal(outcome, undefined, entry.label);
    assert.equal(entry.runtime.pendingBashRoutes.size, 0, entry.label);
    assert.equal(entry.runtime.stats.repairsByAction.get("route-to-bash"), undefined, entry.label);
  }
});

test("parallel call IDs stay isolated and each executes exactly once", async () => {
  const seen: string[] = [];
  const runtime = routeRuntime({
    execute: async ({ command }: RecordedBashCall) => {
      seen.push(command);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: `out:${command}`, isError: false };
    },
  });

  const [first, second] = await Promise.all([
    handleToolCall(runtime, { toolName: "write", toolCallId: "p1", input: { command: "one" } } as any, routeCtx()),
    handleToolCall(runtime, { toolName: "read", toolCallId: "p2", input: { command: "two" } } as any, routeCtx()),
  ]);

  assert.match(first!.reason, /out:one/);
  assert.equal(first!.reason.includes("out:two"), false, "no cross-talk between call IDs");
  assert.match(second!.reason, /out:two/);
  assert.equal(second!.reason.includes("out:one"), false);
  assert.deepEqual(seen.sort(), ["one", "two"]);
  assert.equal(runtime.pendingBashRoutes.size, 2);
});

test("a repeated call ID never executes the command twice", async () => {
  let calls = 0;
  const runtime = routeRuntime({ execute: async () => { calls++; return { text: "once", isError: false }; } });
  const event = { toolName: "write", toolCallId: "dup", input: { command: "echo once" } };

  const first = await handleToolCall(runtime, event as any, routeCtx());
  const second = await handleToolCall(runtime, event as any, routeCtx());

  assert.ok(first);
  assert.equal(second, undefined, "duplicate ID abstains");
  assert.equal(calls, 1);
});

test("the audit event carries source and target tool names only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-route-audit-"));
  const runtime = routeRuntime({ execute: async () => ({ text: "audited output", isError: false }) });
  await handleToolCall(runtime, { toolName: "edit", toolCallId: "audit-1", input: { command: "touch SECRET_MARKER" } } as any, routeCtx({ cwd: root }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const raw = await (await import("node:fs/promises")).readFile(path.join(root, ".pi", "welder-log", "handlers-test.jsonl"), "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  const routed = events.find((event) => Array.isArray(event.repairs) && event.repairs.includes("route-to-bash"))!;
  assert.equal(routed.toolName, "edit", "source tool");
  assert.equal(routed.targetTool, "bash", "target tool");
  assert.deepEqual(routed.inputKeys, []);
  assert.equal(raw.includes("touch SECRET_MARKER"), false, "the command never reaches the log");
  assert.equal(raw.includes("audited output"), false, "command output never reaches the log");
});

test("a routed call result is patched with the real bash outcome when a host emits one", async () => {
  const runtime = routeRuntime({ execute: async () => ({ text: "patched output", details: { truncation: { truncated: false } }, isError: false }) });
  await handleToolCall(runtime, { toolName: "write", toolCallId: "patch-1", input: { command: "echo hi" } } as any, routeCtx());

  const patch = await handleToolResult(runtime, { toolName: "write", toolCallId: "patch-1", isError: true, content: [{ type: "text", text: "block reason" }] } as any, routeCtx());

  assert.ok(patch);
  assert.deepEqual((patch as any).content, [{ type: "text", text: "patched output" }]);
  assert.equal((patch as any).isError, false);
  assert.deepEqual((patch as any).details, { truncation: { truncated: false } });
  assert.equal(runtime.pendingBashRoutes.size, 0, "pending state cleared on consumption");

  const again = await handleToolResult(runtime, { toolName: "write", toolCallId: "patch-1", isError: true } as any, routeCtx());
  assert.equal(again, undefined, "a consumed route is never applied twice");
});

test("session shutdown clears pending routed calls", async () => {
  const runtime = routeRuntime({ execute: async () => ({ text: "x", isError: false }) });
  await handleToolCall(runtime, { toolName: "write", toolCallId: "shutdown-1", input: { command: "ls" } } as any, routeCtx());
  assert.equal(runtime.pendingBashRoutes.size, 1);

  await handleSessionShutdown(runtime, routeCtx());

  assert.equal(runtime.pendingBashRoutes.size, 0);
});
