/**
 * Exact, globally-unique matching semantics shared by the runtime labeler
 * (jev-shadow) and offline tooling (scripts/shadow-labels.ts). A match is
 * valid only when exactly one candidate matches; substring or ambiguous
 * matches are never correlations.
 */

export interface CorrelationCandidate {
  ordinal: number;
  window: string;
}

/** Generic form: the single item satisfying the exact predicate, else undefined. */
export function uniqueMatch<T>(items: readonly T[], isMatch: (item: T) => boolean): T | undefined {
  const matched = items.filter(isMatch);
  return matched.length === 1 ? matched[0] : undefined;
}

export interface CandidateSelection {
  candidates: readonly CorrelationCandidate[];
}

/**
 * Candidate-level global uniqueness: all candidates across all open
 * selections are flattened, and a correlation exists only when exactly one
 * candidate anywhere matches. Per-selection collapsing before the global
 * check would hide equal matches in other selections.
 */
export function uniqueCandidateAcrossSelections<S extends CandidateSelection>(
  selections: readonly S[],
  oldText: string | undefined,
): { selection: S; candidate: CorrelationCandidate } | undefined {
  if (!oldText) return undefined;
  const matches = selections.flatMap((selection) =>
    selection.candidates
      .filter((candidate) => candidate.window === oldText)
      .map((candidate) => ({ selection, candidate })));
  return matches.length === 1 ? matches[0] : undefined;
}
