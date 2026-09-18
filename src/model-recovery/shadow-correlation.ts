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

/** Returns the single matching candidate, or undefined for zero/ambiguous matches. */
export function uniqueCandidateByWindow(
  candidates: readonly CorrelationCandidate[],
  oldText: string | undefined,
): CorrelationCandidate | undefined {
  if (!oldText) return undefined;
  const matches = candidates.filter((candidate) => candidate.window === oldText);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Generic form: the single item satisfying the exact predicate, else undefined. */
export function uniqueMatch<T>(items: readonly T[], isMatch: (item: T) => boolean): T | undefined {
  const matched = items.filter(isMatch);
  return matched.length === 1 ? matched[0] : undefined;
}
