/**
 * TASK-0024 offline pair miner. Deterministic: identical transcript inputs
 * produce identical pairs in identical order. Persisted representations carry
 * metadata only (ids, timestamps, lengths, counts) — edit text, paths, and
 * source windows exist solely in memory for the validity filter and replay.
 *
 * Predeclared extraction rule (fixed PO scope, do not alter): an ambiguous
 * single-edit failure reporting 2–5 exact occurrences, followed later in the
 * same session by a successful single edit on the same path whose oldText
 * strictly extends the failed oldText (contains it and is longer).
 */

export const MIN_REPORTED_OCCURRENCES = 2;
export const MAX_REPORTED_OCCURRENCES = 5;

export interface TranscriptEditCall {
  toolCallId: string;
  ts: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface TranscriptEditOutcome {
  toolCallId: string;
  isError: boolean;
  /** Joined result text, used only to parse the reported occurrence count. */
  errorText?: string;
}

/** In-memory transcript projection; the CLI builds this from session JSONL. */
export interface SessionTranscript {
  sessionId: string;
  cwd: string;
  /** Single-edit calls in transcript order; multi-edit calls are ineligible. */
  calls: readonly TranscriptEditCall[];
  outcomes: readonly TranscriptEditOutcome[];
}

export interface ReplayPair {
  sessionId: string;
  cwd: string;
  failedToolCallId: string;
  failedTs: string;
  successfulToolCallId: string;
  successfulTs: string;
  /** Occurrence count reported by the historical ambiguity failure (2–5). */
  failedOccurrences: number;
  /** Metadata-only lengths for persisted artifacts; never the text itself. */
  failedOldTextLength: number;
  successfulOldTextLength: number;
  /** In-memory only: needed to read current content and build the request. */
  path: string;
  failedOldText: string;
  failedNewText: string;
  successfulOldText: string;
}

const OCCURRENCE_PATTERN = /^Found (\d+) occurrences\b/;

/** Parses the 2–5-relevant occurrence count out of an ambiguity error text. */
export function reportedOccurrences(errorText: string | undefined): number | undefined {
  const match = OCCURRENCE_PATTERN.exec(errorText ?? "");
  return match ? Number(match[1]) : undefined;
}

function isAmbiguousFailure(outcome: TranscriptEditOutcome): number | undefined {
  if (!outcome.isError) return undefined;
  const occurrences = reportedOccurrences(outcome.errorText);
  if (occurrences === undefined || occurrences < MIN_REPORTED_OCCURRENCES || occurrences > MAX_REPORTED_OCCURRENCES) {
    return undefined;
  }
  return occurrences;
}

/** Mines historical ambiguous-edit pairs; deterministic in transcript order. */
export function mineAmbiguousPairs(transcript: SessionTranscript): ReplayPair[] {
  const outcomes = new Map(transcript.outcomes.map((outcome) => [outcome.toolCallId, outcome]));
  const pairs: ReplayPair[] = [];

  for (let index = 0; index < transcript.calls.length; index++) {
    const failed = transcript.calls[index]!;
    const outcome = outcomes.get(failed.toolCallId);
    if (!outcome) continue;
    const occurrences = isAmbiguousFailure(outcome);
    if (occurrences === undefined) continue;

    const success = transcript.calls
      .slice(index + 1)
      .find((candidate) =>
        candidate.path === failed.path &&
        outcomes.get(candidate.toolCallId)?.isError === false &&
        candidate.oldText.includes(failed.oldText) &&
        candidate.oldText.length > failed.oldText.length);
    if (!success) continue;

    pairs.push({
      sessionId: transcript.sessionId,
      cwd: transcript.cwd,
      failedToolCallId: failed.toolCallId,
      failedTs: failed.ts,
      successfulToolCallId: success.toolCallId,
      successfulTs: success.ts,
      failedOccurrences: occurrences,
      failedOldTextLength: failed.oldText.length,
      successfulOldTextLength: success.oldText.length,
      path: failed.path,
      failedOldText: failed.oldText,
      failedNewText: failed.newText,
      successfulOldText: success.oldText,
    });
  }
  return pairs;
}
