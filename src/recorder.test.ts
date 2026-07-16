import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createStats,
  recordRepairs,
  recordToolFailure,
  recordValidation,
  buildEvent,
  buildToolResultEvent,
  buildModelRecoveryEvent,
  appendEvent,
  readEvents,
  loadAllEvents,
  sessionLogPath,
  pruneOldSessions,
  statsSummary,
  writeFailureReport,
  type Repair,
} from "./recorder/index.ts";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "welder-"));

// ─── in-memory stats ────────────────────────────────────────────────────

test("createStats starts empty", () => {
  const s = createStats();
  assert.equal(s.totalToolCalls, 0);
  assert.equal(s.repairedToolCalls, 0);
  assert.equal(s.failedToolResults, 0);
  assert.equal(s.validationChecks, 0);
  assert.equal(s.validationsPassed, 0);
  assert.equal(s.validationsFailed, 0);
  assert.equal(s.validationRejectedRepairs, 0);
  assert.equal(s.failuresByTool.size, 0);
  assert.equal(s.repairsByAction.size, 0);
});

test("recordRepairs counts each action and marks the call repaired", () => {
  const s = createStats();
  const repairs: Repair[] = [
    { field: "input.limit", action: "strip-null" },
    { field: "input.paths", action: "parse-json" },
    { field: "input.strict", action: "coerce-boolean" },
    { field: "input.strict", action: "coerce-boolean" }, // same action twice
  ];
  recordRepairs(s, repairs);
  assert.equal(s.repairedToolCalls, 1);
  assert.equal(s.repairsByAction.get("coerce-boolean"), 2);
  assert.equal(s.repairsByAction.get("parse-json"), 1);
});

test("recordRepairs with no repairs does not mark the call repaired", () => {
  const s = createStats();
  recordRepairs(s, []);
  assert.equal(s.repairedToolCalls, 0);
});

test("recordValidation counts validation outcomes", () => {
  const s = createStats();
  recordValidation(s, { checked: true, passed: true, rejected: false });
  recordValidation(s, { checked: true, passed: false, rejected: true });
  recordValidation(s, undefined);

  assert.equal(s.validationChecks, 2);
  assert.equal(s.validationsPassed, 1);
  assert.equal(s.validationsFailed, 1);
  assert.equal(s.validationRejectedRepairs, 1);
});

test("recordToolFailure counts failed tool results by tool", () => {
  const s = createStats();
  recordToolFailure(s, "read");
  recordToolFailure(s, "read");
  recordToolFailure(s, "edit");
  assert.equal(s.failedToolResults, 3);
  assert.equal(s.failuresByTool.get("read"), 2);
  assert.equal(s.failuresByTool.get("edit"), 1);
});

// ─── event construction ─────────────────────────────────────────────────

test("buildEvent assembles a deterministic-shape event", () => {
  const ev = buildEvent({
    eventType: "tool_call",
    toolName: "edit",
    provider: "anthropic",
    model: "claude",
    repairs: [{ field: "input.limit", action: "strip-null" }],
    inputKeys: ["path", "edits"],
  });
  assert.equal(ev.eventType, "tool_call");
  assert.equal(ev.toolName, "edit");
  assert.deepEqual(ev.repairs, ["strip-null"]);
  assert.equal(ev.wasRepaired, true);
  assert.ok(typeof ev.ts === "string" && ev.ts.length > 0);
});

test("buildEvent with no repairs sets wasRepaired false", () => {
  const ev = buildEvent({ eventType: "tool_call", toolName: "read", provider: "p", model: "m", repairs: [], inputKeys: ["path"] });
  assert.equal(ev.wasRepaired, false);
  assert.deepEqual(ev.repairs, []);
});

test("buildToolResultEvent records bounded failure context", () => {
  const ev = buildToolResultEvent({
    toolName: "read",
    provider: "p",
    model: "m",
    inputKeys: ["path"],
    errorText: "ENOENT\nfull stack that should not all be kept",
  });
  assert.equal(ev.eventType, "tool_result");
  assert.equal(ev.toolName, "read");
  assert.equal(ev.wasError, true);
  assert.equal(ev.errorKind, "ENOENT");
  assert.equal(ev.inputKeys[0], "path");
  assert.match(ev.errorText ?? "", /ENOENT/);
});

test("buildModelRecoveryEvent records reasoning lifecycle context", () => {
  const ev = buildModelRecoveryEvent({
    toolName: "edit", provider: "openrouter", model: "cheap/model", stage: "validated",
    outcome: "rejected", reason: "ambiguous-match", durationMs: 42, confidence: 0.8,
    editCount: 2, unresolvedEditCount: 1, fileBytes: 100,
  });
  assert.equal(ev.eventType, "model_recovery");
  assert.equal(ev.recoveryStage, "validated");
  assert.equal(ev.recoveryReason, "ambiguous-match");
  assert.equal(ev.durationMs, 42);
});

// ─── JSONL append + read round-trip ─────────────────────────────────────

test("appendEvent writes one JSON line per event and readEvents reads them back", async () => {
  const dir = await tmp();
  try {
    const e1 = buildEvent({ eventType: "tool_call", toolName: "edit", provider: "p", model: "m", repairs: [{ field: "a", action: "strip-null" }], inputKeys: ["a"] });
    const e2 = buildEvent({ eventType: "tool_call", toolName: "read", provider: "p", model: "m", repairs: [], inputKeys: ["path"] });
    await appendEvent(dir, "sess-1", e1);
    await appendEvent(dir, "sess-1", e2);

    const events = await readEvents(sessionLogPath(dir, "sess-1"));
    assert.equal(events.length, 2);
    assert.equal(events[0]!.toolName, "edit");
    assert.equal(events[1]!.toolName, "read");
    assert.deepEqual(events[0]!.repairs, ["strip-null"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readEvents on a missing file returns []", async () => {
  const events = await readEvents(path.join(os.tmpdir(), "welder-nope-" + Date.now(), "x.jsonl"));
  assert.deepEqual(events, []);
});

test("readEvents skips blank/malformed lines", async () => {
  const dir = await tmp();
  try {
    const file = sessionLogPath(dir, "s");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, '\n{"eventType":"tool_call","toolName":"x","provider":"p","model":"m","repairs":[],"wasRepaired":false,"inputKeys":[],"ts":"t"}\nnot json\n');
    const events = await readEvents(file);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.toolName, "x");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── loadAllEvents ─────────────────────────────────────────────────────

test("loadAllEvents reads every .jsonl file in the log dir", async () => {
  const dir = await tmp();
  try {
    await appendEvent(dir, "sess-a", buildEvent({ eventType: "tool_call", toolName: "a", provider: "p", model: "m", repairs: [], inputKeys: [] }));
    await appendEvent(dir, "sess-b", buildEvent({ eventType: "tool_call", toolName: "b", provider: "p", model: "m", repairs: [], inputKeys: [] }));
    await fs.writeFile(path.join(dir, "notes.txt"), "ignored");
    const events = await loadAllEvents(dir);
    assert.equal(events.length, 2);
    const names = events.map((e) => e.toolName).sort();
    assert.deepEqual(names, ["a", "b"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadAllEvents on a missing dir returns []", async () => {
  const events = await loadAllEvents(path.join(os.tmpdir(), "welder-nope-" + Date.now()));
  assert.deepEqual(events, []);
});

test("writeFailureReport writes markdown to log dir and returns path", async () => {
  const dir = await tmp();
  try {
    const reportPath = await writeFailureReport(dir, "# report\nbody");
    assert.equal(reportPath, path.join(dir, "failures-report.md"));
    const content = await fs.readFile(reportPath, "utf8");
    assert.match(content, /^# report/);
    assert.match(content, /body/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeFailureReport creates the dir if missing", async () => {
  const dir = path.join(await tmp(), "nested");
  try {
    const reportPath = await writeFailureReport(dir, "x");
    const content = await fs.readFile(reportPath, "utf8");
    assert.equal(content, "x");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── pruning ────────────────────────────────────────────────────────────

test("pruneOldSessions keeps the N newest session files", async () => {
  const dir = await tmp();
  try {
    for (const id of ["sess-old", "sess-mid", "sess-new"]) {
      await appendEvent(dir, id, buildEvent({ eventType: "tool_call", toolName: "t", provider: "p", model: "m", repairs: [], inputKeys: [] }));
      // stagger mtimes so ordering is deterministic
      const file = sessionLogPath(dir, id);
      const backdate = id === "sess-old" ? 1000 : id === "sess-mid" ? 2000 : 3000;
      await fs.utimes(file, new Date(backdate), new Date(backdate));
    }
    const removed = await pruneOldSessions(dir, 2);
    assert.equal(removed, 1);
    const remaining = (await fs.readdir(dir)).sort();
    assert.deepEqual(remaining, ["sess-mid.jsonl", "sess-new.jsonl"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── stats summary ──────────────────────────────────────────────────────

test("statsSummary renders counts and percentages", () => {
  const s = createStats();
  s.totalToolCalls = 10;
  recordRepairs(s, [
    { field: "a", action: "parse-json" },
    { field: "b", action: "parse-json" },
    { field: "c", action: "wrap-array" },
  ]);
  const out = statsSummary(s);
  assert.match(out, /parse-json.*2/);
  assert.match(out, /wrap-array.*1/);
  assert.match(out, /repairs applied : 3/);
  assert.match(out, /tool calls seen : 10/);
});

test("statsSummary renders validations", () => {
  const s = createStats();
  recordValidation(s, { checked: true, passed: true, rejected: false });
  recordValidation(s, { checked: true, passed: false, rejected: true });

  const out = statsSummary(s);
  assert.match(out, /validations    : 2/);
  assert.match(out, /passed       : 1/);
  assert.match(out, /failed       : 1/);
  assert.match(out, /rejected     : 1/);
});

test("statsSummary renders failed tool results", () => {
  const s = createStats();
  recordToolFailure(s, "read");
  recordToolFailure(s, "read");
  recordToolFailure(s, "edit");
  const out = statsSummary(s);
  assert.match(out, /failed results : 3/);
  assert.match(out, /read.*2/);
  assert.match(out, /edit.*1/);
});
