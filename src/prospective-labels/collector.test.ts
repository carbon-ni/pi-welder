import { test } from "node:test";
import assert from "node:assert/strict";

import { createProspectiveLabelCollector, labelLineIsPrivacySafe, labelRecordIsPrivacySafe, renderLabelRecord } from "./collector.ts";
import { appendLine } from "./writer.ts";

const validation = (tool: string) => `Validation failed for tool "${tool}":\n  - path: must have required properties path\n\nReceived arguments:\n{ "execute": "SECRET" }`;

function collector(overrides: { enabled?: boolean } = {}) {
  // The collector never persists: every record is returned to the caller.
  const instance = createProspectiveLabelCollector({
    isEnabled: () => overrides.enabled ?? true,
    sessionId: () => "session-1",
  });
  return { instance };
}

test("opens an episode only after an anchored Pi validation failure", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  assert.equal(instance.pendingCount(), 0, "no episode before confirmation");

  // Each end consumes its start, so negative cases use their own call IDs.
  for (const [id, isError, errorText] of [
    ["n1", false, undefined],
    ["n2", true, "ENOENT"],
    ["n3", true, 'Validation failed for tool "edit":'],
  ] as const) {
    instance.onToolStart({ toolCallId: id, toolName: "write", args: { execute: "git status" } });
    instance.onToolEnd({ toolCallId: id, toolName: "write", isError, ...(errorText === undefined ? {} : { errorText }) });
  }
  assert.equal(instance.pendingCount(), 0, "no episode from success, unrelated errors, or a mismatched header");

  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.equal(instance.pendingCount(), 1, "episode opens on the matching anchored failure");
  assert.equal(instance.stats().validationFailures, 1);
});

test("labels only on a correlated successful tool_execution_end", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });

  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "git status", timeout: 30 } });
  assert.equal(instance.pendingCount(), 1, "no label before the call finishes");
  const records = instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }, 1_000);

  assert.equal(records.length, 1);
  assert.equal(records[0]!.outcome, "labelled");
  assert.equal(records[0]!.targetTool, "bash");
  assert.ok(records[0]!.pairs.includes("command<-execute"));
  assert.equal(instance.pendingCount(), 0, "the episode is consumed");

  // A changed value never labels.
  instance.onToolStart({ toolCallId: "d1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "d1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "d2", toolName: "bash", args: { command: "git diff" } });
  assert.deepEqual(instance.onToolEnd({ toolCallId: "d2", toolName: "bash", isError: false }, 2_000), []);
  assert.equal(instance.pendingCount(), 1, "no label for a changed value");
});

test("a failed, timed-out, aborted, or blocked corrected call consumes the window without labelling", () => {
  for (const label of ["failed", "timeout", "abort", "blocked"]) {
    const { instance } = collector();
    instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
    instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
    instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "git status" } });
    // The call ends in error: no label, window consumed.
    assert.deepEqual(instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: true, errorText: `${label} failure` }), []);
    // Its success late cannot relabel the same episode either (already past).
    assert.deepEqual(instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }), [], label);
  }
});

test("unresolved episodes are persisted on turn end or interruption", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });

  const expired = instance.closeUnresolved("expired", 5_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.outcome, "expired");
  assert.equal(expired[0]!.targetTool, undefined);
  assert.equal(instance.pendingCount(), 0);
  assert.equal(instance.stats().expired, 1);

  instance.onToolStart({ toolCallId: "c2", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c2", toolName: "write", isError: true, errorText: validation("write") });
  const interrupted = instance.closeUnresolved("interrupted", 6_000);
  assert.equal(interrupted[0]!.outcome, "interrupted");
  assert.equal(instance.stats().interrupted, 1);
  assert.equal(expired.length + interrupted.length, 2, "unresolved outcomes are returned, never dropped");
});

test("excludes earlier parallel siblings and expires beyond the window", () => {
  const { instance } = collector();
  // Two calls start in the same batch; c1 fails validation, c2 (started before
  // confirmation) must never label c1's episode.
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.deepEqual(instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }, 1_000), [], "earlier sibling cannot label");

  // A later call that starts after confirmation labels normally.
  instance.onToolStart({ toolCallId: "c3", toolName: "bash", args: { command: "git status" } });
  assert.equal(instance.onToolEnd({ toolCallId: "c3", toolName: "bash", isError: false }, 2_000).length, 1);

  // Beyond three following calls the episode expires, including invalid starts.
  instance.onToolStart({ toolCallId: "e1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "e1", toolName: "write", isError: true, errorText: validation("write") });
  for (const id of ["f1", "f2", "f3", "f4"]) instance.onToolStart({ toolCallId: id, toolName: "write", args: { execute: "git status" } });
  assert.equal(instance.pendingCount(), 0, "expired outside the window");
  assert.equal(instance.onToolEnd({ toolCallId: "f4", toolName: "bash", isError: false }, 3_000).length, 0);
});

test("stays inert when disabled, keeps memory bounded, and clears on cleanup", () => {
  const { instance } = collector({ enabled: false });
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.equal(instance.pendingCount(), 0, "disabled never opens an episode");
  assert.equal(instance.stats().observedCalls, 0);

  const bounded = collector();
  for (let index = 0; index < 30; index++) {
    const id = `p${index}`;
    bounded.instance.onToolStart({ toolCallId: id, toolName: "write", args: { execute: "git status" } });
    bounded.instance.onToolEnd({ toolCallId: id, toolName: "write", isError: true, errorText: validation("write") });
  }
  assert.ok(bounded.instance.pendingCount() <= 8, `bounded pending, got ${bounded.instance.pendingCount()}`);
  assert.ok(bounded.instance.stats().expired > 0, "eviction is counted");

  // Raw retention is bounded by count and bytes, and end removes entries.
  const raw = collector();
  for (let index = 0; index < 60; index++) raw.instance.onToolStart({ toolCallId: `r${index}`, toolName: "write", args: { execute: `cmd ${index}` } });
  assert.ok(raw.instance.stats().retainedRawBytes <= 65_536, `byte cap, got ${raw.instance.stats().retainedRawBytes}`);
  assert.ok(raw.instance.stats().evictedStarts > 0, "start eviction is accounted");
  raw.instance.onToolStart({ toolCallId: "big", toolName: "write", args: { execute: "x".repeat(20_000) } });
  assert.equal(raw.instance.stats().oversizedStarts, 1, "oversized raw args are never retained");

  bounded.instance.clear();
  assert.equal(bounded.instance.pendingCount(), 0);
});

test("records are privacy-safe and the writer rejects oversized or multiline lines", async () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "SECRET_COMMAND --flag /Users/me/x" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "SECRET_COMMAND --flag /Users/me/x" } });
  const returnedRecords = instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }, 1_000);

  const record = returnedRecords[0]!;
  const rendered = renderLabelRecord(record);
  for (const forbidden of ["SECRET_COMMAND", "--flag", "/Users/", "git status"]) {
    assert.equal(rendered.includes(forbidden), false, `record leaked ${forbidden}`);
  }
  assert.equal(labelRecordIsPrivacySafe(record), true);
  assert.equal(record.outcome, "labelled");
  assert.ok(record.request, "the closed judge-input snapshot is persisted for replay");
  assert.equal(JSON.stringify(record.request).includes("SECRET_COMMAND"), false);
  assert.equal(labelRecordIsPrivacySafe({ ...record, sourceTool: "bad tool!" }), false);

  const written: string[] = [];
  const mkdirImpl = async () => undefined;
  const appendImpl = async (_path: unknown, data: string) => { written.push(data); };
  await appendLine("/tmp/x", "s.labels.jsonl", rendered, { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  assert.equal(written.length, 1);
  await appendLine("/tmp/x", "s.labels.jsonl", "x".repeat(5_000), { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  await appendLine("/tmp/x", "s.labels.jsonl", "two\nlines", { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  assert.equal(written.length, 1, "oversized and multiline lines are rejected");
});

test("privacy guards reject forged secret and nested fields at the write boundary", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "printf ok" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "printf ok" } });
  const labelled = instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }, 1_000);
  const record = labelled[0]!;

  // The rendered line is safe, and a forged top-level field is rejected.
  assert.equal(labelLineIsPrivacySafe(renderLabelRecord(record)), true);
  const forgedTop = JSON.parse(renderLabelRecord(record));
  forgedTop.command = "SECRET";
  assert.equal(labelLineIsPrivacySafe(JSON.stringify(forgedTop)), false, "unknown top-level field");

  // A secret hidden inside the nested request snapshot is rejected.
  const forgedNested = JSON.parse(renderLabelRecord(record));
  forgedNested.request.leak = "SECRET_COMMAND";
  assert.equal(labelLineIsPrivacySafe(JSON.stringify(forgedNested)), false, "unknown nested field");

  const forgedDeep = JSON.parse(renderLabelRecord(record));
  forgedDeep.request.plans[0].fields[0].features.leak = { deep: "SECRET" };
  assert.equal(labelLineIsPrivacySafe(JSON.stringify(forgedDeep)), false, "unknown deep nested feature field");

  // Non-object and multiline payloads fail closed.
  assert.equal(labelLineIsPrivacySafe("not json"), false);
  assert.equal(labelLineIsPrivacySafe(`${renderLabelRecord(record)}\nextra`), false);
  assert.equal(labelLineIsPrivacySafe(JSON.stringify({ ...record, eventType: "other" })), false);
});

test("stress: repeated validation failures stay bounded and every eviction returns an outcome", () => {
  const { instance } = collector();
  const returned: any[] = [];
  for (let index = 0; index < 20; index++) {
    const id = `s${index}`;
    returned.push(...instance.onToolStart({ toolCallId: id, toolName: "write", args: { execute: `cmd ${index}` } }, index));
    returned.push(...instance.onToolEnd({ toolCallId: id, toolName: "write", isError: true, errorText: validation("write") }, index));
  }
  assert.ok(instance.pendingCount() <= 8, `pending stays bounded, got ${instance.pendingCount()}`);
  assert.equal(returned.length, 20 - instance.pendingCount(), "every eviction is returned as an outcome");
  assert.ok(returned.every((record) => record.outcome === "expired"), "evicted episodes are closed as expired");
  assert.equal(instance.stats().episodesOpened, 20);
  assert.equal(instance.stats().expired, 20 - instance.pendingCount());
});

test("privacy: a forged secret in each closed enum and in ids/pairs/outcome is rejected", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "printf ok" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "printf ok" } });
  const record = instance.onToolEnd({ toolCallId: "c2", toolName: "bash", isError: false }, 1_000)[0]!;
  const base = renderLabelRecord(record);
  assert.equal(labelLineIsPrivacySafe(base), true);

  const mutators: Array<[string, (parsed: any) => void]> = [
    ["outcome", (parsed) => { parsed.outcome = "SECRET"; }],
    ["sourceTool", (parsed) => { parsed.sourceTool = "SECRET TOOL"; }],
    ["targetTool", (parsed) => { parsed.targetTool = "not a tool!"; }],
    ["pair syntax", (parsed) => { parsed.pairs = ["command<-SECRET COMMAND"]; }],
    ["plan ordinal range", (parsed) => { parsed.planOrdinal = 99; }],
    ["feature kind", (parsed) => { parsed.request.plans[0].fields[0].features.kind = "SECRET"; }],
    ["feature shape", (parsed) => { parsed.request.plans[0].fields[0].features.shape = "SECRET"; }],
    ["length bucket", (parsed) => { parsed.request.plans[0].fields[0].features.lengthBucket = "SECRET"; }],
    ["token bucket", (parsed) => { parsed.request.plans[0].fields[0].features.tokenBucket = "SECRET"; }],
    ["item bucket", (parsed) => { parsed.request.plans[0].fields[0].features.itemBucket = "SECRET"; }],
    ["nested secret", (parsed) => { parsed.request.leak = "SECRET"; }],
    ["secret sessionId", (parsed) => { parsed.sessionId = "SECRET SESSION"; }],
    ["secret episodeId", (parsed) => { parsed.episodeId = "SECRET_EPISODE"; }],
    ["empty pair source", (parsed) => { parsed.pairs = ["command<-"]; }],
    ["empty pair role", (parsed) => { parsed.pairs = ["<-execute"]; }],
    ["empty pair", (parsed) => { parsed.pairs = ["<-"]; }],
  ];
  for (const [label, mutate] of mutators) {
    const parsed = JSON.parse(base);
    mutate(parsed);
    assert.equal(labelLineIsPrivacySafe(JSON.stringify(parsed)), false, label);
  }
});
