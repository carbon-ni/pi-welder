/**
 * TASK-0022 — historical missing-read pair miner. Deterministic: identical
 * transcript inputs produce identical pairs in identical order. Paths exist
 * in memory only; persisted views are metadata-only (lengths, counts).
 */

export interface TranscriptReadCall {
  toolCallId: string;
  ts: string;
  path: string;
}

export interface TranscriptReadOutcome {
  toolCallId: string;
  isError: boolean;
  /** Joined result text, used only to classify the failure. */
  errorText?: string;
}

export interface ReadTranscript {
  sessionId: string;
  cwd: string;
  calls: readonly TranscriptReadCall[];
  outcomes: readonly TranscriptReadOutcome[];
}

export interface MissingReadPair {
  sessionId: string;
  cwd: string;
  failedToolCallId: string;
  failedTs: string;
  /** In-memory only; never persisted. */
  missingPath: string;
  successToolCallId: string;
  successTs: string;
  /** In-memory only; never persisted. */
  successPath: string;
}

/** True for the read-missing-path failure class (ENOENT / no such file). */
export function isMissingPathError(errorText: string | undefined): boolean {
  const lower = (errorText ?? "").toLowerCase();
  return lower.includes("enoent") || lower.includes("no such file");
}

/** Pairs each missing read with the next successful read in the same session. */
export function mineMissingReadPairs(transcript: ReadTranscript): MissingReadPair[] {
  const outcomes = new Map(transcript.outcomes.map((outcome) => [outcome.toolCallId, outcome]));
  const pairs: MissingReadPair[] = [];

  for (let index = 0; index < transcript.calls.length; index++) {
    const failed = transcript.calls[index]!;
    const outcome = outcomes.get(failed.toolCallId);
    if (!outcome || !outcome.isError || !isMissingPathError(outcome.errorText)) continue;

    // A later success on the SAME path means the file appeared (create/rename),
    // not that the path was corrected; it carries no candidate-ranking signal.
    const success = transcript.calls
      .slice(index + 1)
      .find((candidate) => candidate.path !== failed.path && outcomes.get(candidate.toolCallId)?.isError === false);
    if (!success) continue;

    pairs.push({
      sessionId: transcript.sessionId,
      cwd: transcript.cwd,
      failedToolCallId: failed.toolCallId,
      failedTs: failed.ts,
      missingPath: failed.path,
      successToolCallId: success.toolCallId,
      successTs: success.ts,
      successPath: success.path,
    });
  }
  return pairs;
}

/** Metadata-only persisted view: no paths, only lengths. */
export interface MissingReadPairMetadata {
  sessionId: string;
  failedToolCallId: string;
  failedTs: string;
  successToolCallId: string;
  successTs: string;
  missingPathLength: number;
  successPathLength: number;
  sameBasename: boolean;
}

export function pairMetadata(pair: MissingReadPair): MissingReadPairMetadata {
  const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);
  return {
    sessionId: pair.sessionId,
    failedToolCallId: pair.failedToolCallId,
    failedTs: pair.failedTs,
    successToolCallId: pair.successToolCallId,
    successTs: pair.successTs,
    missingPathLength: pair.missingPath.length,
    successPathLength: pair.successPath.length,
    sameBasename: basename(pair.missingPath) === basename(pair.successPath),
  };
}

/** Deterministic top-1/top-5 hit rates over generated candidate orderings. */
export interface HitRates {
  pairs: number;
  generated: number;
  top1: number;
  top5: number;
  top1Rate: number;
  top5Rate: number;
}

export function computeHitRates(
  pairs: readonly MissingReadPair[],
  candidatesFor: (pair: MissingReadPair) => readonly string[] | undefined,
): HitRates {
  let generated = 0;
  let top1 = 0;
  let top5 = 0;
  for (const pair of pairs) {
    const candidates = candidatesFor(pair);
    if (!candidates || candidates.length === 0) continue;
    generated++;
    const rank = candidates.indexOf(pair.successPath);
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 5) top5++;
  }
  return {
    pairs: pairs.length,
    generated,
    top1,
    top5,
    top1Rate: generated === 0 ? 0 : top1 / generated,
    top5Rate: generated === 0 ? 0 : top5 / generated,
  };
}
