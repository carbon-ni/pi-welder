import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLimitArg, registerWelderCommands, statusSummary, welderCommandSpecs } from "./commands.ts";
import { createRuntime } from "./runtime.ts";

function ctx(overrides: Partial<any> = {}): any {
  return {
    hasUI: true,
    cwd: "/workspace/project",
    sessionManager: { getSessionId: () => "commands-test" },
    ui: { notify: () => {}, setStatus: () => {} },
    ...overrides,
  };
}

test("parseLimitArg accepts unsigned integers only", () => {
  assert.equal(parseLimitArg("3"), 3);
  assert.equal(parseLimitArg(" 10 "), 10);
  assert.equal(parseLimitArg(""), null);
  assert.equal(parseLimitArg("1.5"), null);
  assert.equal(parseLimitArg("-1"), null);
});

const expectedCommands = [
  ["welder-stats", "Show pi-welder repair stats for this session"],
  ["welder-status", "Show pi-welder runtime status"],
  ["welder-reset", "Reset pi-welder session stats and pending recovery guidance"],
  ["welder-on", "Enable pi-welder repairs"],
  ["welder-off", "Disable pi-welder repairs (analytics still tracked in-memory)"],
  ["welder-toggle", "Toggle pi-welder repairs on/off"],
  ["welder-log", "Show the path to this session's welder repair log"],
  ["welder-guidance", "Show current pi-welder recovery guidance from recent tool failures"],
  ["welder-failures", "Show pending pi-welder tool failures without recovery hints"],
  ["welder-guidance-limit", "Set max recent tool failures included in recovery guidance (1-10)"],
  ["welder-clear", "Clear pending pi-welder recovery guidance"],
];

test("welderCommandSpecs document command names and descriptions", () => {
  const runtime = createRuntime();
  assert.deepEqual(
    welderCommandSpecs(runtime).map((spec) => [spec.name, spec.description]),
    expectedCommands,
  );
});

test("registerWelderCommands registers all command handlers", () => {
  const commands: Record<string, unknown> = {};
  registerWelderCommands({ registerCommand: (name: string, def: unknown) => { commands[name] = def; } } as any, createRuntime());

  assert.deepEqual(Object.keys(commands), expectedCommands.map(([name]) => name));
});

test("statusSummary renders runtime state and session log path", () => {
  const runtime = createRuntime();
  runtime.enabled = false;
  runtime.stats.totalToolCalls = 2;
  runtime.stats.failedToolResults = 1;
  runtime.recovery.failures.push({ toolName: "read", inputKeys: [], errorText: "ENOENT", ts: "now" });

  const summary = statusSummary(ctx(), runtime);

  assert.match(summary, /enabled\s+: false/);
  assert.match(summary, /tool calls seen\s+: 2/);
  assert.match(summary, /failed results\s+: 1/);
  assert.match(summary, /commands-test\.jsonl/);
});
