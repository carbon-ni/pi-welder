import { test } from "node:test";
import assert from "node:assert/strict";

import { loadMineEvents, mineFailures, mineSummary, parseMineSource, registerWelderCommands, welderCommandSpecs } from "./commands.ts";
import { createRuntime } from "./runtime.ts";
import { buildToolResultEvent, type FailureEvent, type WelderEvent } from "./recorder/index.ts";

function ctx(overrides: Partial<any> = {}): any {
  return {
    hasUI: true,
    cwd: "/workspace/project",
    sessionManager: { getSessionId: () => "commands-test" },
    ui: { notify: () => {}, setStatus: () => {} },
    ...overrides,
  };
}

const expectedCommands = [
  ["welder-stats", "Show pi-welder repair stats for this session"],
  ["welder-shadow-stats", "Show metadata-only Jev shadow activity and labels for this session"],
  ["welder-reset", "Reset pi-welder session stats and pending failures"],
  ["welder-log", "Show the path to this session's welder repair log"],
  ["welder-failures", "Show pending pi-welder tool failures and input keys"],
  ["welder-clear", "Clear pending pi-welder failures"],
  ["welder-settings", "Toggle pi-welder config options (TUI)"],
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

test("welder-settings notifies an error outside TUI mode", async () => {
  const runtime = createRuntime();
  let notified: { msg: string; kind: string } | null = null;
  const spec = welderCommandSpecs(runtime).find((s) => s.name === "welder-settings")!;
  await spec.handler("", { mode: undefined, ui: { notify: (msg: string, kind: string) => { notified = { msg, kind }; } } } as any);
  assert.equal(notified!.kind, "error");
  assert.match(notified!.msg, /TUI/);
});

test("welder-shadow-stats reports metadata-only aggregates from live shadow evidence", async () => {
  const runtime = createRuntime();
  runtime.shadowEvidence.push(
    { toolCallId: "call-1", candidateCount: 3, selectedOrdinal: 2, confidence: 0.97, latencyMs: 120, status: "selected", labelStatus: "provisional-correct" },
    { toolCallId: "call-2", candidateCount: 2, confidence: 0.4, latencyMs: 80, status: "abstain", labelStatus: "pending" },
  );
  runtime.sourceShadowingEnabled = true;

  let notified = "";
  const spec = welderCommandSpecs(runtime).find((s) => s.name === "welder-shadow-stats")!;
  await spec.handler("", { mode: undefined, ui: { notify: (msg: string) => { notified = msg; } } } as any);

  assert.match(notified, /metadata only/);
  assert.match(notified, /completed : 2/);
  assert.match(notified, /selected  : 1/);
  assert.match(notified, /abstained : 1/);
  assert.match(notified, /provisional-correct: 1/);
  // No toolCallIds, paths, or payloads in the summary.
  assert.doesNotMatch(notified, /call-1|call-2|path|oldText|newText|toolCallId/);
});

// ─── mineFailures ───────────────────────────────────────────────────────

function failureEvent(toolName: string, errorText: string): WelderEvent {
  return buildToolResultEvent({ toolName, provider: "p", model: "m", inputKeys: ["path"], errorText });
}

test("mineFailures aggregates events, writes report, returns summary", async () => {
  const events: FailureEvent[] = [
    failureEvent("read", "ENOENT no such file"),
    failureEvent("read", "ENOENT another"),
    failureEvent("edit", "EDIT_MISMATCH oldText not found"),
  ];
  let written = "";
  const result = await mineFailures(events, "/fake/log", async (_dir, content) => {
    written = content;
    return "/fake/log/failures-report.md";
  }, "all");

  assert.equal(result.reportPath, "/fake/log/failures-report.md");
  assert.equal(result.clusters, 2);
  assert.equal(result.totalFailures, 3);
  assert.match(result.topCluster ?? "", /read \/ ENOENT.*2/);
  assert.match(written, /# pi-welder failure report/);
});

test("mineFailures includes per-model repairs only when feature flag is enabled", async () => {
  const event: WelderEvent = {
    ts: "t", eventType: "tool_call", toolName: "edit", provider: "anthropic", model: "opus",
    repairs: ["strip-extra-props"], wasRepaired: true, inputKeys: ["edits"],
  };
  const reports: string[] = [];
  const write = async (_dir: string, content: string) => { reports.push(content); return "/report.md"; };

  await mineFailures([event], "/logs", write, "welder", false);
  await mineFailures([event], "/logs", write, "welder", true);

  assert.doesNotMatch(reports[0]!, /repairs by model/i);
  assert.match(reports[1]!, /anthropic \/ opus \/ edit \/ strip-extra-props/i);
});

test("mineFailures with no events returns zero clusters", async () => {
  const result = await mineFailures([], "/fake/log", async () => "/fake/log/failures-report.md", "pi");
  assert.equal(result.clusters, 0);
  assert.equal(result.totalFailures, 0);
  assert.equal(result.topCluster, null);
  assert.equal(result.source, "pi");
});

test("mineSummary renders empty state", () => {
  const out = mineSummary({ reportPath: "/x/failures-report.md", source: "all", clusters: 0, totalFailures: 0, topCluster: null });
  assert.match(out, /no failures found/i);
  assert.match(out, /source: all/);
  assert.match(out, /\/x\/failures-report\.md/);
});

test("mineSummary renders top cluster and counts", () => {
  const out = mineSummary({ reportPath: "/x/failures-report.md", source: "pi", clusters: 3, totalFailures: 12, topCluster: "read / ENOENT (×6)" });
  assert.match(out, /clusters  : 3/);
  assert.match(out, /failures  : 12/);
  assert.match(out, /top       : read \/ ENOENT/);
  assert.match(out, /source    : pi/);
});

// ─── parseMineSource ────────────────────────────────────────────────────

test("parseMineSource accepts pi, welder, all; defaults to all", () => {
  assert.equal(parseMineSource("pi"), "pi");
  assert.equal(parseMineSource("WELDER"), "welder");
  assert.equal(parseMineSource("all"), "all");
  assert.equal(parseMineSource(""), "all");
  assert.equal(parseMineSource("bogus"), "all");
});

// ─── loadMineEvents ─────────────────────────────────────────────────────

test("loadMineEvents welder source loads only welder dir", async () => {
  const events = await loadMineEvents("welder", {
    welderLogDir: "/w",
    piSessionsDir: "/p",
    loadWelder: async (d) => { assert.equal(d, "/w"); return [failureEvent("read", "ENOENT")]; },
    loadPi: async () => { throw new Error("pi should not be called for welder source"); },
  });
  assert.equal(events.length, 1);
});

test("loadMineEvents pi source loads only pi dir", async () => {
  const events = await loadMineEvents("pi", {
    welderLogDir: "/w",
    piSessionsDir: "/p",
    loadWelder: async () => { throw new Error("welder should not be called for pi source"); },
    loadPi: async (d) => { assert.equal(d, "/p"); return [failureEvent("edit", "EDIT_MISMATCH")]; },
  });
  assert.equal(events.length, 1);
});

test("loadMineEvents all source merges both, tolerates load failure", async () => {
  const events = await loadMineEvents("all", {
    welderLogDir: "/w",
    piSessionsDir: "/p",
    loadWelder: async () => [failureEvent("read", "ENOENT")],
    loadPi: async () => { throw new Error("boom"); },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.toolName, "read");
});

test("syncRuntimeConfig applies the live bash-routing gate without a restart", async () => {
  const { createRuntime } = await import("./runtime.ts");
  const { syncRuntimeConfig } = await import("./commands.ts");
  const runtime = createRuntime({});

  const base = {
    modelRepairReportingEnabled: false,
    recoveryGuidanceLimit: 3,
    repairsEnabled: true,
    disabledRepairs: [] as string[],
    sourceShadowingEnabled: false,
    readPathRepairEnabled: false,
  };

  assert.equal(runtime.bashRouteState.isEnabled(), false, "off by default");

  syncRuntimeConfig(runtime, { ...base, commandReroutingEnabled: true });
  assert.equal(runtime.commandReroutingEnabled, true, "toggled live");
  assert.equal(runtime.bashRouteState.isEnabled(), true);

  syncRuntimeConfig(runtime, { ...base, repairsEnabled: false, commandReroutingEnabled: true });
  assert.equal(runtime.bashRouteState.isEnabled(), false, "master repairs switch gates routing");

  syncRuntimeConfig(runtime, { ...base, commandReroutingEnabled: true, disabledRepairs: ["route-to-bash"] });
  assert.equal(runtime.bashRouteState.isEnabled(), false, "disabling the route-to-bash repair gates routing");

  syncRuntimeConfig(runtime, { ...base, commandReroutingEnabled: true });
  assert.equal(runtime.bashRouteState.isEnabled(), true, "re-enabling restores routing");
});
