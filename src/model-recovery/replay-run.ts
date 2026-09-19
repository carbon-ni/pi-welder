/**
 * TASK-0024 offline replay runner. Sends pre-declared, redacted, containment-
 * checked candidate windows from the validity filter through the existing
 * JevClient — the byte-identical pipeline live shadowing uses.
 *
 * Predeclared budget (fixed PO scope): at most 200 sequential calls, 2-second
 * timeout each, zero retries. Aborted requests are recorded as timeout
 * failures and never re-attempted. Only closed-schema metadata is emitted;
 * candidate windows exist solely inside the in-memory request.
 */

import type { JevClient, JevClientError } from "../infra/typesafe.ts";
import type { ShadowStatus } from "./jev-shadow.ts";
import { parseWorksheet, sortRows, renderRowCells, WORKSHEET_COLUMNS, type ShadowRow } from "./shadow-labels.ts";
import type { AmbiguousShadowRequest } from "./ambiguous-shadow.ts";

export const REPLAY_BUDGET = 200;
export const REPLAY_TIMEOUT_MS = 2_000;

/** Replay worksheet = shadow-labels format plus the prefilled historical target. */
export const REPLAY_WORKSHEET_COLUMNS: readonly string[] = (() => {
  const columns: string[] = [...WORKSHEET_COLUMNS];
  columns.splice(columns.indexOf("verified-target"), 0, "historical-target");
  return columns;
})();

export interface PreparedPair {
  sessionId: string;
  /** Opaque id of the historical ambiguous (failed) edit call. */
  toolCallId: string;
  ts: string;
  candidateCount: number;
  groundTruthOrdinal: number;
  request: AmbiguousShadowRequest;
}

export interface ReplayRow extends ShadowRow {
  historicalTarget: number;
}

export interface ReplayCallRecord {
  toolCallId: string;
  sessionId: string;
  ts: string;
  status: ShadowStatus;
  latencyMs: number;
  model?: string;
  selectedOrdinal?: number;
  confidence?: number;
}

export interface ReplayRunStats {
  pairs: number;
  attempted: number;
  budget: number;
  headroom: number;
}

export interface ReplayRunResult {
  rows: ReplayRow[];
  calls: ReplayCallRecord[];
  stats: ReplayRunStats;
}

export interface RunShadowReplayOptions {
  prepared: readonly PreparedPair[];
  client: JevClient;
  budget?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Runs the budgeted, sequential, zero-retry replay over prepared pairs. */
export async function runShadowReplay(options: RunShadowReplayOptions): Promise<ReplayRunResult> {
  const budget = options.budget ?? REPLAY_BUDGET;
  const timeoutMs = options.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const rows: ReplayRow[] = [];
  const calls: ReplayCallRecord[] = [];
  const attempted = Math.min(options.prepared.length, Math.max(0, budget));

  for (const pair of options.prepared.slice(0, attempted)) {
    const record = await replayOne(pair, options.client, timeoutMs, now);
    calls.push(record);
    rows.push(toRow(pair, record));
  }

  return { rows, calls, stats: { pairs: options.prepared.length, attempted, budget, headroom: budget - attempted } };
}

async function replayOne(
  pair: PreparedPair,
  client: JevClient,
  timeoutMs: number,
  now: () => number,
): Promise<ReplayCallRecord> {
  const controller = new AbortController();
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("replay timeout"));
      }, timeoutMs);
    });
    const answer = await Promise.race([
      client.choose({ candidates: pair.request.candidates, requestedEditText: pair.request.requestedEditText }, controller.signal),
      timeout,
    ]);
    return settle(pair, answer, startedAt, now);
  } catch (error) {
    const status: ShadowStatus = timedOut
      ? "timeout"
      : statusForError(error);
    return record(pair, status, startedAt, now);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Predeclared TASK-0020 operating point: only >= 0.9 confidence is a selection. */
export const CONFIDENCE_GATE = 0.9;

function settle(
  pair: PreparedPair,
  answer: { choice: number | null; confidence?: number; model?: string },
  startedAt: number,
  now: () => number,
): ReplayCallRecord {
  const latencyMs = Math.max(0, now() - startedAt);
  const confidence = answer.confidence;
  const validOrdinal = answer.choice === null || pair.request.candidates.some((candidate) => candidate.ordinal === answer.choice);
  const selected = validOrdinal
    && answer.choice !== null
    && confidence !== undefined
    && Number.isFinite(confidence)
    && confidence >= CONFIDENCE_GATE;
  const status: ShadowStatus = !validOrdinal
    ? "malformed"
    : answer.choice === null
      ? "abstain"
      : selected
        ? "selected"
        : "low-confidence";

  return {
    toolCallId: pair.toolCallId,
    sessionId: pair.sessionId,
    ts: pair.ts,
    status,
    latencyMs,
    ...(answer.model === undefined ? {} : { model: answer.model }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(selected ? { selectedOrdinal: answer.choice! } : {}),
  };
}

function statusForError(error: unknown): ShadowStatus {
  const kind = (error as Partial<JevClientError> | undefined)?.kind;
  if (kind === "rate-limited") return "rate-limited";
  if (kind === "malformed") return "malformed";
  return "transport";
}

function record(pair: PreparedPair, status: ShadowStatus, startedAt: number, now: () => number): ReplayCallRecord {
  return {
    toolCallId: pair.toolCallId,
    sessionId: pair.sessionId,
    ts: pair.ts,
    status,
    latencyMs: Math.max(0, now() - startedAt),
  };
}

function toRow(pair: PreparedPair, record: ReplayCallRecord): ReplayRow {
  return {
    toolCallId: pair.toolCallId,
    sessionId: pair.sessionId,
    ts: pair.ts,
    candidateCount: pair.candidateCount,
    ...(record.selectedOrdinal !== undefined ? { selectedOrdinal: record.selectedOrdinal } : {}),
    ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
    labelStatus: "pending",
    outcome: record.status,
    latencyMs: record.latencyMs,
    // Historically correlated by construction: pairs come from transcripts.
    linked: true,
    historicalTarget: pair.groundTruthOrdinal,
  };
}

/** Deterministic rendering: same rows -> byte-identical worksheet. */
export function buildReplayWorksheet(rows: readonly ReplayRow[]): string {
  const header = REPLAY_WORKSHEET_COLUMNS.join("\t");
  const body = sortRows(rows).map((row) => renderRowCells(row, REPLAY_WORKSHEET_COLUMNS));
  return [header, ...body].join("\n") + "\n";
}

/** Round-trips replay worksheets including the historical-target column. */
export function parseReplayWorksheet(text: string): ReplayRow[] {
  return parseWorksheet(text) as ReplayRow[];
}

