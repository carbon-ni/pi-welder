import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createEpisodeTracker,
  episodeCoverage,
  formatEpisodeReport,
  type EpisodeRecord,
} from "./episodes.ts";
import { buildEpisodeEvent } from "./recorder/index.ts";
import { readEvents } from "./recorder/log.ts";

function fixedClock() {
  let id = 0;
  return { now: () => 1_000_000, nextId: () => `ep-${++id}` };
}

function trackerWithWindow(window: number) {
  return createEpisodeTracker({ ...fixedClock(), window });
}

test("opens a repair-warning episode with deterministic id and dedupes redelivered records", () => {
  const tracker = trackerWithWindow(3);
  const source = {
    kind: "repair-warning" as const,
    toolName: "edit",
    repairs: [{ field: "edits", action: "nest-edit-fields" }],
    provider: "p",
    model: "m",
    inputKeys: ["edits"],
    dedupeKey: "edit|nest-edit-fields|1",
  };

  tracker.open(source);
  tracker.open({ ...source });
  tracker.open({ ...source, dedupeKey: "edit|nest-edit-fields|2" });

  assert.equal(tracker.openCount, 2);
});

test("opens a result-repair episode from an applied patch", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({
    kind: "result-repair",
    toolName: "read",
    repairs: [{ field: "path", action: "missing-read-context" }],
    provider: "p",
    model: "m",
    inputKeys: ["path"],
  });

  assert.equal(tracker.openCount, 1);
});

test("closes with valid only when the relevant call and result are both observed", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  // Result without an observed call must not infer success from silence.
  let records = tracker.observeResult({ toolName: "edit", isError: false });
  assert.equal(records.length, 0);
  assert.equal(tracker.openCount, 1);

  tracker.observeCall({ toolName: "edit", actions: [] });
  records = tracker.observeResult({ toolName: "edit", isError: false });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "valid");
  assert.equal(records[0]?.episodeId, "ep-1");
});

test("closes with repaired-recurrence when the same action recurs", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  tracker.observeCall({ toolName: "edit", actions: ["nest-edit-fields"] });
  const records = tracker.observeResult({ toolName: "edit", isError: false });

  assert.equal(records[0]?.outcome, "repaired-recurrence");
});

test("closes with repaired-other when a different repair occurs", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  tracker.observeCall({ toolName: "edit", actions: ["strip-null"] });
  const records = tracker.observeResult({ toolName: "edit", isError: false });

  assert.equal(records[0]?.outcome, "repaired-other");
});

test("closes with failed when the observed result is an error", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  tracker.observeCall({ toolName: "edit", actions: [] });
  const records = tracker.observeResult({ toolName: "edit", isError: true });

  assert.equal(records[0]?.outcome, "failed");
});

test("unrelated calls are counted but neither close the episode nor consume the window", () => {
  const tracker = trackerWithWindow(1);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  tracker.observeCall({ toolName: "read", actions: [] });
  tracker.observeResult({ toolName: "read", isError: false });
  tracker.observeCall({ toolName: "bash", actions: [] });
  tracker.observeResult({ toolName: "bash", isError: true });
  assert.equal(tracker.openCount, 1);

  tracker.observeCall({ toolName: "edit", actions: [] });
  const records = tracker.observeResult({ toolName: "edit", isError: false });

  assert.equal(records[0]?.outcome, "valid");
  assert.equal(records[0]?.unrelatedCalls, 2);
});

test("closes with expired when the same-tool call horizon is exhausted without a result", () => {
  const tracker = trackerWithWindow(1);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  tracker.observeCall({ toolName: "edit", actions: [] });
  assert.equal(tracker.openCount, 1, "awaiting the observed result");

  // A further same-tool call with the horizon spent expires the episode.
  tracker.observeCall({ toolName: "edit", actions: [] });
  assert.equal(tracker.openCount, 0);
});

test("closeAll flushes open episodes as expired", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({ kind: "repair-warning", toolName: "edit", repairs: [{ field: "e", action: "nest-edit-fields" }] });

  const records = tracker.closeAll();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "expired");
  assert.equal(tracker.openCount, 0);
});

test("evicts the oldest episode when the open cap is exceeded", () => {
  const tracker = createEpisodeTracker({ ...fixedClock(), window: 3, maxOpen: 2 });
  const evicted: EpisodeRecord[] = [];
  const open = (toolName: string) => evicted.push(...tracker.open({ kind: "repair-warning", toolName, repairs: [{ field: "f", action: "strip-null" }] }));

  open("a");
  open("b");
  assert.equal(evicted.length, 0);
  open("c");

  assert.equal(evicted.length, 1);
  assert.equal(evicted[0]?.toolName, "a");
  assert.equal(evicted[0]?.outcome, "expired");
});

test("episode events carry only privacy-safe metadata", () => {
  const tracker = trackerWithWindow(3);
  tracker.open({
    kind: "repair-warning",
    toolName: "edit",
    repairs: [{ field: "edits", action: "nest-edit-fields" }],
    provider: "p",
    model: "m",
    inputKeys: ["path", "edits"],
  });
  tracker.observeCall({ toolName: "edit", actions: ["nest-edit-fields"] });
  const [record] = tracker.observeResult({ toolName: "edit", isError: false });

  assert.ok(record);
  const json = JSON.stringify(buildEpisodeEvent(record, 1_000_000));
  assert.doesNotMatch(json, /\/users|\/home|oldText.*value|content"/i);
  assert.match(json, /"episodeId":"ep-1"/);
  assert.match(json, /"inputKeys":\["path","edits"\]/);
});

test("episodeCoverage and report measure label coverage", () => {
  const events = [
    { eventType: "episode", outcome: "valid" },
    { eventType: "episode", outcome: "repaired-recurrence" },
    { eventType: "episode", outcome: "expired" },
    { eventType: "tool_call", wasError: false },
  ] as any[];

  const coverage = episodeCoverage(events);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.byOutcome.valid, 1);
  assert.equal(coverage.byOutcome["repaired-recurrence"], 1);
  assert.equal(coverage.observed, 2);
  assert.equal(coverage.expired, 1);

  const report = formatEpisodeReport(events);
  assert.match(report, /episodes: 3/);
  assert.match(report, /valid: 1/);
  assert.match(report, /coverage: 2\/3/);
});

test("episode events parse alongside legacy events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "welder-episodes-"));
  const file = path.join(dir, "sess.jsonl");
  const legacy = JSON.stringify({ ts: "t", eventType: "tool_call", toolName: "read", provider: "p", model: "m", repairs: [], wasRepaired: false, inputKeys: [] });
  const episode = JSON.stringify(buildEpisodeEvent({
    episodeId: "ep-1", kind: "repair-warning", toolName: "edit", provider: "p", model: "m",
    repairs: ["nest-edit-fields"], inputKeys: ["edits"], outcome: "valid", window: 3,
    unrelatedCalls: 0, ts: "t",
  }, 1_000_000));
  await writeFile(file, `${legacy}\n${episode}\n`, "utf8");

  const events = await readEvents(file);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.eventType, "tool_call");
  assert.equal(events[1]?.eventType, "episode");
  assert.equal(events[1]?.outcome, "valid");
});

test("handlers record episode outcomes for delivered warnings", async () => {
  const { handleContext, handleToolCall, handleToolResult } = await import("./handlers.ts");
  const { createRuntime } = await import("./runtime.ts");
  const root = await mkdtemp(path.join(tmpdir(), "welder-epi-handlers-"));

  const runtime = createRuntime();
  const base = { sessionManager: { getSessionId: () => "epi-test" }, model: { provider: "p", id: "m" } } as any;

  await handleToolCall(runtime, { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } } as any, { ...base, cwd: root });
  await handleContext(runtime, { messages: [] } as any, { ...base, cwd: root });

  // Relevant retry: valid edit call with observed successful result.
  await handleToolCall(runtime, { toolCallId: "c2", toolName: "edit", input: { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] } } as any, { ...base, cwd: root });
  await handleToolResult(runtime, { toolCallId: "c2", toolName: "edit", input: {}, isError: false, content: "ok" } as any, { ...base, cwd: root });

  const events = await readEvents(path.join(root, ".pi", "welder-log", "epi-test.jsonl"));
  const episodes = events.filter((e) => e.eventType === "episode");
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.kind, "repair-warning");
  assert.equal(episodes[0]?.outcome, "valid");
});

test("handler episode logging survives recorder failure", async () => {
  const { handleContext } = await import("./handlers.ts");
  const { createRuntime } = await import("./runtime.ts");
  const root = await mkdtemp(path.join(tmpdir(), "welder-epi-fail-"));
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "not a directory");
  await mkdir(path.join(blocker, "nested"), { recursive: true }).catch(() => {});

  const runtime = createRuntime();
  runtime.repairWarnings = {
    warnings: [{ toolName: "edit", repairs: [{ field: "edits", action: "nest-edit-fields" }], ts: "t" }],
    maxWarnings: 5,
    deliveredSnapshot: null,
  };

  const out = await handleContext(runtime, { messages: [] } as any, { hasUI: false, cwd: blocker } as any);
  assert.ok(out);
});

test("result-repair patches open episodes that observe the next outcome", async () => {
  const { handleToolCall, handleToolResult } = await import("./handlers.ts");
  const { createRuntime } = await import("./runtime.ts");
  const { mkdtemp: md } = await import("node:fs/promises");
  const root = await md(path.join(tmpdir(), "welder-epi-result-"));
  await mkdir(path.join(root, "sub"), { recursive: true });

  const runtime = createRuntime();
  const base = { sessionManager: { getSessionId: () => "epi-result" }, model: { provider: "p", id: "m" } } as any;

  // Failed directory read -> directory-read enrichment patch delivered.
  await handleToolResult(
    runtime,
    { toolName: "read", input: { path: "sub" }, isError: true, content: "EISDIR" } as any,
    { ...base, cwd: root },
  );

  // Next relevant call+result is valid.
  await handleToolCall(runtime, { toolCallId: "c2", toolName: "read", input: { path: "sub/a.txt" } } as any, { ...base, cwd: root });
  await handleToolResult(runtime, { toolCallId: "c2", toolName: "read", input: {}, isError: false, content: "data" } as any, { ...base, cwd: root });

  const events = await readEvents(path.join(root, ".pi", "welder-log", "epi-result.jsonl"));
  const episodes = events.filter((e) => e.eventType === "episode");
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.kind, "result-repair");
  assert.equal(episodes[0]?.outcome, "valid");
});

test("session shutdown flushes open episodes as expired", async () => {
  const { handleToolCall, handleContext, handleSessionShutdown } = await import("./handlers.ts");
  const { createRuntime } = await import("./runtime.ts");
  const root = await mkdtemp(path.join(tmpdir(), "welder-epi-shutdown-"));

  const runtime = createRuntime();
  const base = { sessionManager: { getSessionId: () => "epi-shutdown" }, model: { provider: "p", id: "m" } } as any;

  await handleToolCall(runtime, { toolName: "edit", input: { edits: { oldText: "a", newText: "b" } } } as any, { ...base, cwd: root });
  await handleContext(runtime, { messages: [] } as any, { ...base, cwd: root });
  await handleSessionShutdown(runtime, { ...base, cwd: root, hasUI: false });

  const events = await readEvents(path.join(root, ".pi", "welder-log", "epi-shutdown.jsonl"));
  const episodes = events.filter((e) => e.eventType === "episode");
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.outcome, "expired");
});

test("welder-log file for privacy sanity holds no argument values from episode records", async () => {
  const tracker = trackerWithWindow(3);
  tracker.open({
    kind: "result-repair",
    toolName: "read",
    repairs: [{ field: "path", action: "missing-read-context" }],
    provider: "p",
    model: "m",
    inputKeys: ["path"],
  });
  tracker.observeCall({ toolName: "read", actions: [] });
  const [record] = tracker.observeResult({ toolName: "read", isError: false });

  assert.ok(record);
  const event = buildEpisodeEvent(record, 1_000_000);
  const json = JSON.stringify(event);
  assert.equal(Object.keys(event).filter((k) => k === "errorText" || k === "content").length, 0);
  assert.ok(!json.includes("EISDIR"));
});

test("report reads written episode logs end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "welder-epi-report-"));
  const file = path.join(dir, "sess.jsonl");
  const line = JSON.stringify(buildEpisodeEvent({
    episodeId: "ep-1", kind: "repair-warning", toolName: "edit", provider: "p", model: "m",
    repairs: ["nest-edit-fields"], inputKeys: ["edits"], outcome: "valid", window: 3,
    unrelatedCalls: 1, ts: "t",
  }, 1_000_000));
  await writeFile(file, `${line}\n`, "utf8");

  const events = await readEvents(file);
  await readFile(file, "utf8");
  assert.match(formatEpisodeReport(events), /coverage: 1\/1/);
});
