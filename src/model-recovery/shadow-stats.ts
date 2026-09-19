/**
 * TASK-0027 — metadata-only shadow observability.
 *
 * Pure aggregation over closed shadow records. Never reads or emits source
 * windows, paths, edit text, credentials, or provider payloads. Deterministic:
 * identical inputs produce byte-identical reports.
 *
 * Governance guard: activity metrics (submitted/completed/statuses/latency)
 * are kept separate from effectiveness metrics (labels). No precision or
 * eligible-case denominator is inferred from completed events.
 */

import type { ShadowEvidence } from "./jev-shadow.ts";

export type ShadowStatusName =
  | "selected"
  | "abstain"
  | "low-confidence"
  | "malformed"
  | "rate-limited"
  | "transport"
  | "timeout"
  | "cancelled";

export type ShadowLabelName =
  | "pending"
  | "provisional-correct"
  | "provisional-incorrect"
  | "unresolved";

/** Closed metadata record — the only shape the aggregator ever sees. */
export interface ShadowRecord {
  candidateCount?: number;
  selectedOrdinal?: number;
  confidence?: number;
  latencyMs?: number;
  status?: string;
  labelStatus?: string;
}

export interface ConfidenceBucket {
  id: string;
  /** Inclusive lower bound; undefined means "no confidence recorded". */
  min?: number;
  max?: number;
  count: number;
}

export interface ShadowStats {
  submitted: number | undefined;
  completed: number;
  selected: number;
  abstained: number;
  lowConfidence: number;
  statuses: Record<string, number>;
  errorStatuses: Record<string, number>;
  confidenceBuckets: readonly ConfidenceBucket[];
  latencyMs: { p50: number | undefined; p95: number | undefined; max: number | undefined; count: number };
  labels: Record<ShadowLabelName, number>;
}

const STATUS_ORDER: readonly ShadowStatusName[] = [
  "selected", "abstain", "low-confidence", "malformed", "rate-limited", "transport", "timeout", "cancelled",
];

const ERROR_STATUSES: ReadonlySet<string> = new Set(["malformed", "rate-limited", "transport", "timeout", "cancelled"]);

const LABEL_ORDER: readonly ShadowLabelName[] = ["pending", "provisional-correct", "provisional-incorrect", "unresolved"];

/** Confidence buckets (deterministic boundaries; lower inclusive, upper exclusive). */
const CONFIDENCE_BUCKETS: readonly { id: string; min?: number; max?: number }[] = [
  { id: "unset" },
  { id: "<0.50", max: 0.5 },
  { id: "0.50-0.79", min: 0.5, max: 0.8 },
  { id: "0.80-0.89", min: 0.8, max: 0.9 },
  { id: ">=0.90", min: 0.9 },
];

function percentile(sorted: readonly number[], ratio: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index]!;
}

/** Aggregates closed shadow records deterministically. `submitted` is caller-known. */
export function aggregateShadowStats(records: readonly ShadowRecord[], submitted?: number): ShadowStats {
  const statuses: Record<string, number> = {};
  for (const status of STATUS_ORDER) statuses[status] = 0;

  let selected = 0;
  let abstained = 0;
  let lowConfidence = 0;
  const confidenceBuckets = CONFIDENCE_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }));
  const latencies: number[] = [];
  const labels: Record<ShadowLabelName, number> = { pending: 0, "provisional-correct": 0, "provisional-incorrect": 0, unresolved: 0 };

  for (const record of records) {
    const status = record.status ?? "unknown";
    statuses[status] = (statuses[status] ?? 0) + 1;

    if (status === "selected") selected++;
    else if (status === "abstain") abstained++;
    else if (status === "low-confidence") lowConfidence++;

    const bucket = record.confidence === undefined
      ? confidenceBuckets.find((candidate) => candidate.id === "unset")
      : confidenceBuckets.find((candidate) =>
          candidate.id !== "unset"
          && (candidate.min === undefined || record.confidence! >= candidate.min)
          && (candidate.max === undefined || record.confidence! < candidate.max));
    if (bucket) bucket.count++;

    if (typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs) && record.latencyMs >= 0) {
      latencies.push(record.latencyMs);
    }

    const label = record.labelStatus;
    if (label === "pending" || label === "provisional-correct" || label === "provisional-incorrect") {
      labels[label]++;
    } else {
      labels.unresolved++;
    }
  }

  latencies.sort((a, b) => a - b);

  return {
    submitted,
    completed: records.length,
    selected,
    abstained,
    lowConfidence,
    statuses,
    errorStatuses: Object.fromEntries(
      Object.entries(statuses).filter(([status]) => ERROR_STATUSES.has(status)),
    ),
    confidenceBuckets,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length > 0 ? latencies[latencies.length - 1] : undefined,
      count: latencies.length,
    },
    labels,
  };
}

/** Renders a deterministic, metadata-only text summary (stable key order). */
export function renderShadowStats(stats: ShadowStats): string {
  const lines: string[] = [
    "pi-welder shadow stats (metadata only)",
    "submitted : " + (stats.submitted === undefined ? "n/a" : String(stats.submitted)),
    "completed : " + String(stats.completed),
    "selected  : " + String(stats.selected),
    "abstained : " + String(stats.abstained),
    "low-conf. : " + String(stats.lowConfidence),
    "latency   : p50=" + fmtMs(stats.latencyMs.p50) + " p95=" + fmtMs(stats.latencyMs.p95) + " max=" + fmtMs(stats.latencyMs.max) + " n=" + stats.latencyMs.count,
  ];
  lines.push("statuses:");
  for (const [status, count] of Object.entries(stats.statuses)) {
    lines.push(`  ${status}: ${count}`);
  }
  lines.push("confidence buckets:");
  for (const bucket of stats.confidenceBuckets) {
    lines.push(`  ${bucket.id}: ${bucket.count}`);
  }
  lines.push("labels:");
  for (const label of LABEL_ORDER) {
    lines.push(`  ${label}: ${stats.labels[label]}`);
  }
  return lines.join("\n") + "\n";
}

function fmtMs(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

// --- closed-record adapters -----------------------------------------------------

/** Live runtime evidence → closed metadata record (no payloads). */
export function fromShadowEvidence(evidence: ShadowEvidence): ShadowRecord {
  return {
    candidateCount: evidence.candidateCount,
    ...(evidence.selectedOrdinal === undefined ? {} : { selectedOrdinal: evidence.selectedOrdinal }),
    ...(evidence.confidence === undefined ? {} : { confidence: evidence.confidence }),
    latencyMs: evidence.latencyMs,
    status: evidence.status,
    labelStatus: evidence.labelStatus,
  };
}

/** Closed shadow event → metadata record; non-shadow events return undefined. */
export function fromShadowEvent(event: Record<string, unknown>): ShadowRecord | undefined {
  if (event["eventType"] !== "shadow") return undefined;
  return {
    ...(typeof event["candidateCount"] === "number" ? { candidateCount: event["candidateCount"] } : {}),
    ...(typeof event["selectedOrdinal"] === "number" ? { selectedOrdinal: event["selectedOrdinal"] } : {}),
    ...(typeof event["confidence"] === "number" ? { confidence: event["confidence"] } : {}),
    ...(typeof event["latencyMs"] === "number" ? { latencyMs: event["latencyMs"] } : {}),
    ...(typeof event["outcome"] === "string" ? { status: event["outcome"] } : {}),
    ...(typeof event["labelStatus"] === "string" ? { labelStatus: event["labelStatus"] } : {}),
  };
}
