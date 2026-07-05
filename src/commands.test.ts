import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLimitArg, registerWelderCommands, statusSummary } from "./commands.ts";
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

test("registerWelderCommands registers all command handlers", () => {
  const commands: Record<string, unknown> = {};
  registerWelderCommands({ registerCommand: (name: string, def: unknown) => { commands[name] = def; } } as any, createRuntime());

  assert.deepEqual(Object.keys(commands), [
    "welder-stats",
    "welder-status",
    "welder-reset",
    "welder-on",
    "welder-off",
    "welder-toggle",
    "welder-log",
    "welder-guidance",
    "welder-failures",
    "welder-guidance-limit",
    "welder-clear",
  ]);
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
