import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateShadowStats,
  fromShadowEvent,
  fromShadowEvidence,
  renderShadowStats,
  type ShadowRecord,
} from "./shadow-stats.ts";

function record(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return { candidateCount: 2, latencyMs: 10, status: "selected", labelStatus: "pending", ...overrides };
}

test("aggregates activity metrics separately from label metrics, deterministically", () => {
  const records: ShadowRecord[] = [
    record({ status: "selected", confidence: 0.99, selectedOrdinal: 1, labelStatus: "provisional-correct", latencyMs: 100 }),
    record({ status: "selected", confidence: 0.95, selectedOrdinal: 2, labelStatus: "provisional-incorrect", latencyMs: 200 }),
    record({ status: "abstain", confidence: 0.5, labelStatus: "pending", latencyMs: 50 }),
    record({ status: "low-confidence", confidence: 0.3, labelStatus: "pending", latencyMs: 75 }),
    record({ status: "timeout", labelStatus: "pending", latencyMs: 2000 }),
    record({ status: "rate-limited", labelStatus: "pending", latencyMs: 30 }),
    record({ status: "transport", labelStatus: "pending", latencyMs: 40 }),
    record({ status: "malformed", labelStatus: "pending", latencyMs: 20 }),
    record({ status: "cancelled", labelStatus: "pending", latencyMs: 10 }),
  ];

  const stats = aggregateShadowStats(records, 15);
  assert.equal(stats.submitted, 15);
  assert.equal(stats.completed, 9);
  assert.equal(stats.selected, 2);
  assert.equal(stats.abstained, 1);
  assert.equal(stats.lowConfidence, 1);
  assert.deepEqual(stats.statuses.selected, 2);
  assert.deepEqual(stats.statuses.timeout, 1);
  assert.deepEqual(stats.statuses["rate-limited"], 1);
  assert.deepEqual(stats.statuses.transport, 1);
  assert.deepEqual(stats.statuses.malformed, 1);
  assert.deepEqual(stats.statuses.cancelled, 1);
  assert.deepEqual(stats.errorStatuses, { malformed: 1, "rate-limited": 1, transport: 1, timeout: 1, cancelled: 1 });
  assert.equal(stats.confidenceBuckets.find((bucket) => bucket.id === ">=0.90")!.count, 2);
  assert.equal(stats.confidenceBuckets.find((bucket) => bucket.id === "0.50-0.79")!.count, 1);
  assert.equal(stats.confidenceBuckets.find((bucket) => bucket.id === "<0.50")!.count, 1);
  assert.equal(stats.confidenceBuckets.find((bucket) => bucket.id === "unset")!.count, 5);
  assert.equal(stats.labels["provisional-correct"], 1);
  assert.equal(stats.labels["provisional-incorrect"], 1);
  assert.equal(stats.labels.pending, 7);
  assert.equal(stats.labels.unresolved, 0);

  const latencies = [100, 200, 50, 75, 2000, 30, 40, 20, 10].sort((a, b) => a - b);
  assert.equal(stats.latencyMs.p50, latencies[Math.floor(latencies.length * 0.5)]);
  assert.equal(stats.latencyMs.p95, latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]);
  assert.equal(stats.latencyMs.max, 2000);
  assert.equal(stats.latencyMs.count, 9);

  assert.deepEqual(aggregateShadowStats(records, 15), aggregateShadowStats(records, 15));
  assert.equal(renderShadowStats(stats), renderShadowStats(aggregateShadowStats(records, 15)));
});

test("empty and legacy input fails closed to zero/unknown, never throws", () => {
  const empty = aggregateShadowStats([], undefined);
  assert.equal(empty.completed, 0);
  assert.equal(empty.submitted, undefined);
  assert.equal(empty.latencyMs.p50, undefined);
  assert.equal(empty.latencyMs.p95, undefined);
  assert.equal(empty.latencyMs.max, undefined);
  for (const label of ["pending", "provisional-correct", "provisional-incorrect", "unresolved"] as const) {
    assert.equal(empty.labels[label], 0);
  }

  // Legacy/unknown status and label bucket into "unknown"/"unresolved" without failing.
  const legacy = aggregateShadowStats([record({ status: undefined, labelStatus: "legacy-label" })]);
  assert.equal(legacy.statuses.unknown, 1);
  assert.equal(legacy.labels.unresolved, 1);

  assert.match(renderShadowStats(empty), /submitted : n\/a/);
  assert.match(renderShadowStats(empty), /completed : 0/);
});

test("fromShadowEvent accepts closed shadow events and rejects everything else", () => {
  assert.deepEqual(fromShadowEvent({ eventType: "shadow", candidateCount: 2, selectedOrdinal: 1, confidence: 0.9, latencyMs: 5, outcome: "selected", labelStatus: "pending" }), {
    candidateCount: 2, selectedOrdinal: 1, confidence: 0.9, latencyMs: 5, status: "selected", labelStatus: "pending",
  });
  assert.equal(fromShadowEvent({ eventType: "tool_call" }), undefined);
  assert.deepEqual(fromShadowEvent({ eventType: "shadow" }), {});
  // Privacy: non-shadow content fields are never surfaced even if present.
  const guarded = fromShadowEvent({ eventType: "shadow", path: "/etc/passwd", oldText: "secret", command: "rm -rf", outcome: "selected" });
  assert.equal(JSON.stringify(guarded).includes("secret"), false);
  assert.equal(JSON.stringify(guarded).includes("/etc/passwd"), false);
});

test("fromShadowEvidence strips payloads down to closed metadata", () => {
  const record = fromShadowEvidence({
    toolCallId: "call-1",
    candidateCount: 3,
    selectedOrdinal: 2,
    confidence: 0.97,
    model: "jev-latest",
    latencyMs: 120,
    status: "selected",
    labelStatus: "provisional-correct",
  });
  assert.deepEqual(record, { candidateCount: 3, selectedOrdinal: 2, confidence: 0.97, latencyMs: 120, status: "selected", labelStatus: "provisional-correct" });
  assert.equal(JSON.stringify(record).includes("toolCallId"), false);
  assert.equal(JSON.stringify(record).includes("model"), false);
});

test("the rendered report is metadata-only and byte-deterministic", () => {
  const stats = aggregateShadowStats([record({ confidence: 0.99, selectedOrdinal: 1 }), record({ status: "abstain", confidence: 0.4 })], 2);
  const text = renderShadowStats(stats);
  assert.equal(text, renderShadowStats(stats));
  assert.match(text, /metadata only/);
  // No source/payload terms may appear in the report.
  assert.doesNotMatch(text, /path|oldText|newText|window|command|source|credential|api[_-]?key/i);
});
