import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorksheet,
  computeMetrics,
  linkTranscript,
  parseShadowEvent,
  parseWorksheet,
} from "./shadow-labels.ts";

function row(overrides: Partial<any> = {}): any {
  return {
    toolCallId: "tool:1:aaa",
    sessionId: "s-1",
    ts: "2026-09-17T00:00:00.000Z",
    candidateCount: 3,
    selectedOrdinal: 2,
    confidence: 0.97,
    labelStatus: "pending",
    outcome: "selected",
    latencyMs: 120,
    ...overrides,
  };
}

test("parseShadowEvent accepts only complete shadow events", () => {
  assert.ok(parseShadowEvent({ eventType: "shadow", toolCallId: "t", candidateCount: 2, labelStatus: "pending", outcome: "selected", latencyMs: 1 }));
  assert.equal(parseShadowEvent({ eventType: "tool_call", toolCallId: "t", candidateCount: 2 }), undefined);
  assert.equal(parseShadowEvent({ eventType: "shadow", candidateCount: 2 }), undefined);
  assert.equal(parseShadowEvent({ eventType: "shadow", toolCallId: "t" }), undefined);
});

test("worksheet round-trips rows deterministically with a blank verified-target column", () => {
  const rows = [
    row({ toolCallId: "b", sessionId: "s-1" }),
    row({ toolCallId: "a", sessionId: "s-2" }),
    row({ toolCallId: "z", sessionId: "s-1" }),
  ];
  const text = buildWorksheet(rows);
  const lines = text.split("\n").filter((line) => line.length > 0);
  assert.equal(lines[0], "toolCallId\tsessionId\tts\tcandidateCount\tselectedOrdinal\tconfidence\tlabelStatus\toutcome\tlatencyMs\tlinked\tverified-target");
  assert.match(lines[3]!, /^a\ts-2\t/);
  assert.ok(lines.every((line) => line.split("\t").length === 11));
  assert.ok(lines[1]!.endsWith("\t"), "verified-target starts blank");

  const parsed = parseWorksheet(text);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[2]?.toolCallId, "a");
  assert.equal(parsed[0]?.verifiedTarget, undefined);

  // Determinism: identical inputs produce identical worksheets.
  assert.equal(text, buildWorksheet([...rows].reverse()));
});

test("computeMetrics follows the predeclared 0.9 protocol", () => {
  const rows = [
    row({ confidence: 0.97, verifiedTarget: "2" }),                       // correct attempted
    row({ confidence: 0.97, verifiedTarget: "1" }),                       // wrong target
    row({ confidence: 0.97, verifiedTarget: "unresolvable" }),            // excluded, counted
    row({ confidence: 0.97, verifiedTarget: "9" }),                       // out of range: not reviewable
    row({ confidence: 0.8, selectedOrdinal: 1, verifiedTarget: "1" }),    // sub-threshold = abstention
    row({ selectedOrdinal: undefined, confidence: 1, verifiedTarget: "" }), // abstain
  ];
  const metrics = computeMetrics(rows);
  assert.equal(metrics.total, 6);
  assert.equal(metrics.attemptedSelections, 4);
  assert.equal(metrics.abstentions, 2);
  assert.ok(Math.abs(metrics.abstentionRate - 1/3) < 1e-9);
  assert.equal(metrics.reviewedAttempted, 2);
  assert.equal(metrics.correct, 1);
  assert.equal(metrics.wrongTarget, 1);
  assert.equal(metrics.unresolvable, 1);
  assert.equal(metrics.precision, 0.5);
});

test("computeMetrics is empty-safe and 0.99 gate helper reports unreviewed sets", () => {
  assert.equal(computeMetrics([]).precision, undefined);
  assert.equal(computeMetrics([]).abstentionRate, 0);
});

test("linkTranscript reuses exact globally-unique matching", () => {
  const transcripts = [
    { sessionId: "s-1", editCallIds: ["tool:1:aaa", "tool:2:bbb"] },
    { sessionId: "s-2", editCallIds: ["tool:3:ccc"] },
  ];
  assert.deepEqual(linkTranscript(transcripts, row()), { transcript: "s-1", callLinked: true });
  assert.deepEqual(linkTranscript(transcripts, row({ sessionId: "missing" })), { callLinked: false });
  assert.deepEqual(linkTranscript(transcripts, row({ toolCallId: "nope" })), { transcript: "s-1", callLinked: false });
  // Duplicate session dirs (e.g. reruns) must not create ambiguous links.
  assert.deepEqual(linkTranscript([...transcripts, { sessionId: "s-1", editCallIds: ["tool:1:aaa"] }], row()), { callLinked: false });
});

test("parseWorksheet rejects a headerless worksheet instead of misparsing", () => {
  assert.throws(() => parseWorksheet("tool:1\ts-1\tt\t2\t1\t0.9\tpending\tselected\t1\t1\n"), /header row/);
});

test("worksheet round-trips the linked boolean", () => {
  const text = buildWorksheet([row({ linked: true }), row({})]);
  const parsed = parseWorksheet(text);
  assert.equal(parsed[0]?.linked, true);
  assert.equal(parsed[1]?.linked, false);
});
