/**
 * TASK-0024 validity filter. Honest about drift: a mined pair survives only
 * when the historical ambiguity still exists in the *current* file content —
 * the failed oldText still yields 2–5 exact matches today and the successful
 * oldText still resolves to exactly one match today.
 *
 * Request construction, caps, redaction, and containment are reused verbatim
 * from the live pipeline (buildAmbiguousShadowRequest); no model client is
 * accepted here, so this filter can never make an API call.
 */

import {
  buildAmbiguousShadowRequest,
  occurrenceOffsets,
  readContainedSource,
  type AmbiguousShadowRequest,
  MAX_CANDIDATES,
} from "./ambiguous-shadow.ts";
import type { FileSystem } from "../infra/filesystem.ts";
import type { ReplayPair } from "./replay-pairs.ts";

export type PairValidity =
  | { verdict: "valid"; request: AmbiguousShadowRequest; groundTruthOrdinal: number; candidateCount: number }
  | { verdict: "invalid"; reason: "unreadable-or-escaped" | "failed-oldtext-not-ambiguous-today" | "successful-oldtext-not-unique-today" | "request-rejected" }
  | { verdict: "unresolvable"; reason: "ground-truth-not-unique" };

/**
 * Re-evaluates a mined pair against current content. Returns a Jev-ready
 * request plus the historical ground-truth ordinal, or the attrition reason.
 */
export async function evaluatePairValidity(
  pair: ReplayPair,
  fileSystem?: FileSystem,
): Promise<PairValidity> {
  const current = await readContainedSource({ cwd: pair.cwd, target: pair.path, fileSystem });
  if (current === undefined) return { verdict: "invalid", reason: "unreadable-or-escaped" };

  const failedOffsets = occurrenceOffsets(current, pair.failedOldText);
  if (failedOffsets.length < 2 || failedOffsets.length > MAX_CANDIDATES) {
    return { verdict: "invalid", reason: "failed-oldtext-not-ambiguous-today" };
  }

  const request = await buildAmbiguousShadowRequest({
    cwd: pair.cwd,
    toolInput: { path: pair.path, edits: [{ oldText: pair.failedOldText, newText: pair.failedNewText }] },
    fileSystem,
  });
  if (!request) return { verdict: "invalid", reason: "request-rejected" };

  const successOffsets = occurrenceOffsets(current, pair.successfulOldText);
  if (successOffsets.length !== 1) {
    return { verdict: "invalid", reason: "successful-oldtext-not-unique-today" };
  }

  // Historical ground truth: the candidate occurrence fully contained in the
  // successful oldText's span. More than one (or none) means the transcript
  // does not establish a unique intended target for today's content.
  const start = successOffsets[0]!;
  const end = start + pair.successfulOldText.length;
  const inside = failedOffsets
    .map((offset, index) => ({ offset, ordinal: index + 1 }))
    .filter(({ offset }) => offset >= start && offset + pair.failedOldText.length <= end);
  if (inside.length !== 1) return { verdict: "unresolvable", reason: "ground-truth-not-unique" };

  return {
    verdict: "valid",
    request,
    groundTruthOrdinal: inside[0]!.ordinal,
    candidateCount: request.candidates.length,
  };
}
