import { uniqueMatch } from "./shadow-correlation.ts";

/**
 * Offline label-extraction core for TASK-0020. Deterministic: identical
 * inputs produce identical worksheets and metrics. Only safe shadow
 * metadata (ids, counts, ordinals, statuses) is ever represented here —
 * never source windows, edit text, or paths.
 */

export const WORKSHEET_COLUMNS = [
  "toolCallId",
  "sessionId",
  "ts",
  "candidateCount",
  "selectedOrdinal",
  "confidence",
  "labelStatus",
  "outcome",
  "latencyMs",
  "linked",
  "verified-target",
] as const;

export interface ShadowRow {
  toolCallId: string;
  sessionId: string;
  ts: string;
  candidateCount: number;
  selectedOrdinal?: number;
  confidence?: number;
  labelStatus: string;
  outcome: string;
  latencyMs: number;
  /** Reviewer aid: true only when the row linked to exactly one transcript edit call. */
  linked?: boolean;
  /** Offline replay only (TASK-0024): historical ground-truth ordinal, never used by metrics. */
  historicalTarget?: number;
  verifiedTarget?: string;
}

/** Predeclared operating point (fixed PO scope; do not change). */
export const CONFIDENCE_THRESHOLD = 0.9;

export function parseShadowEvent(event: Record<string, unknown>): ShadowRow | undefined {
  if (event.eventType !== "shadow") return undefined;
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
  const candidateCount = typeof event.candidateCount === "number" ? event.candidateCount : undefined;
  if (!toolCallId || candidateCount === undefined) return undefined;
  return {
    toolCallId,
    sessionId: typeof event.sessionId === "string" ? event.sessionId : "",
    ts: typeof event.ts === "string" ? event.ts : "",
    candidateCount,
    ...(typeof event.selectedOrdinal === "number" ? { selectedOrdinal: event.selectedOrdinal } : {}),
    ...(typeof event.confidence === "number" ? { confidence: event.confidence } : {}),
    labelStatus: typeof event.labelStatus === "string" ? event.labelStatus : "",
    outcome: typeof event.outcome === "string" ? event.outcome : "",
    latencyMs: typeof event.latencyMs === "number" ? event.latencyMs : 0,
  };
}

/** Deterministic row order: sessionId, ts, toolCallId. */
export function sortRows(rows: readonly ShadowRow[]): ShadowRow[] {
  return [...rows].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId) || a.ts.localeCompare(b.ts) || a.toolCallId.localeCompare(b.toolCallId));
}

function renderCell(row: ShadowRow, column: string): string {
  if (column === "verified-target") return row.verifiedTarget ?? "";
  if (column === "historical-target") return row.historicalTarget === undefined ? "" : String(row.historicalTarget);
  if (column === "linked") return String(row.linked ?? false);
  const value = row[column as keyof ShadowRow];
  return value === undefined ? "" : String(value);
}

/** Generic cell renderer so replay worksheets can extend the column set. */
export function renderRowCells(row: ShadowRow, columns: readonly string[]): string {
  return columns.map((column) => renderCell(row, column)).join("\t");
}

export function buildWorksheet(rows: readonly ShadowRow[]): string {
  const header = WORKSHEET_COLUMNS.join("\t");
  const body = sortRows(rows).map((row) => renderRowCells(row, WORKSHEET_COLUMNS));
  return [header, ...body].join("\n") + "\n";
}

export function parseWorksheet(text: string): ShadowRow[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const columns = lines[0]!.split("\t");
  if (!columns.includes("toolCallId") || !columns.includes("verified-target")) {
    throw new Error("Worksheet is missing its header row; keep the first line unchanged when editing.");
  }
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const record: Record<string, string> = {};
    columns.forEach((column, index) => { record[column] = cells[index] ?? ""; });
    return {
      toolCallId: record.toolCallId ?? "",
      sessionId: record.sessionId ?? "",
      ts: record.ts ?? "",
      candidateCount: Number(record.candidateCount ?? 0),
      ...(record.selectedOrdinal ? { selectedOrdinal: Number(record.selectedOrdinal) } : {}),
      ...(record.confidence ? { confidence: Number(record.confidence) } : {}),
      labelStatus: record.labelStatus ?? "",
      outcome: record.outcome ?? "",
      latencyMs: Number(record.latencyMs ?? 0),
      linked: record.linked === "true",
      ...(record["historical-target"] ? { historicalTarget: Number(record["historical-target"]) } : {}),
      ...(record["verified-target"] ? { verifiedTarget: record["verified-target"] } : {}),
    } as ShadowRow;
  });
}

export interface ShadowMetrics {
  threshold: number;
  total: number;
  attemptedSelections: number;
  abstentions: number;
  abstentionRate: number;
  reviewedAttempted: number;
  correct: number;
  wrongTarget: number;
  unresolvable: number;
  precision: number | undefined;
}

/**
 * Predeclared protocol (fixed before any precision computation):
 * - attempted selection = selectedOrdinal present AND confidence >= threshold;
 * - everything else counts as abstention;
 * - unresolvable rows are excluded from precision and counted;
 * - wrong-target = attempted selection whose ordinal differs from the
 *   verified intended target.
 */
export function computeMetrics(rows: readonly ShadowRow[], threshold = CONFIDENCE_THRESHOLD): ShadowMetrics {
  const attempted = rows.filter((row) => row.selectedOrdinal !== undefined && (row.confidence ?? 0) >= threshold);
  const unresolvable = rows.filter((row) => row.verifiedTarget === "unresolvable").length;
  const reviewed = attempted.filter((row) => isVerifiedOrdinal(row));
  const correct = reviewed.filter((row) => row.verifiedTarget === String(row.selectedOrdinal)).length;
  const wrongTarget = reviewed.length - correct;
  return {
    threshold,
    total: rows.length,
    attemptedSelections: attempted.length,
    abstentions: rows.length - attempted.length,
    abstentionRate: rows.length === 0 ? 0 : (rows.length - attempted.length) / rows.length,
    reviewedAttempted: reviewed.length,
    correct,
    wrongTarget,
    unresolvable,
    precision: reviewed.length === 0 ? undefined : correct / reviewed.length,
  };
}

function isVerifiedOrdinal(row: ShadowRow): boolean {
  if (!row.verifiedTarget) return false;
  if (row.verifiedTarget === "unresolvable") return false;
  const ordinal = Number(row.verifiedTarget);
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= row.candidateCount;
}

/**
 * Correlation reuses the exact globally-unique matching semantics from
 * shadow-correlation.ts: a transcript link exists only when exactly one
 * transcript file matches the session id and exactly one edit call in it
 * matches the opaque toolCallId.
 */
export function linkTranscript(
  transcripts: readonly { sessionId: string; editCallIds: readonly string[] }[],
  row: ShadowRow,
): { transcript?: string; callLinked: boolean } {
  const transcript = uniqueMatch(transcripts, (entry) => entry.sessionId === row.sessionId);
  if (!transcript) return { callLinked: false };
  const call = uniqueMatch(transcript.editCallIds, (id) => id === row.toolCallId);
  return { transcript: row.sessionId, callLinked: call !== undefined };
}
