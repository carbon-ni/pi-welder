/**
 * TASK-0031 — bounded deterministic edit-mismatch anchor candidates.
 *
 * Candidates are closed transformations of the FAILED attempted anchor only.
 * The later successful edit payload is never an input; it is only used as a
 * local label. Generation is deterministic, bounded to five, and each
 * candidate carries structural features (never text).
 */

export const MAX_MISMATCH_CANDIDATES = 5;

export type TransformKind = "verbatim" | "line-ending" | "indentation" | "trimmed" | "whitespace-collapsed";
export type LengthBucket = "same" | "shorter" | "longer";
export type SimilarityBucket = "identical" | "whitespace-only" | "different";

export interface MismatchCandidate {
  ordinal: number;
  transform: TransformKind;
  similarity: SimilarityBucket;
  lengthBucket: LengthBucket;
  lineCount: number;
  /** In-memory candidate text; never transmitted or reported. */
  text: string;
}

function toLf(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function collapseInlineWhitespace(value: string): string {
  return value.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n");
}

function dedent(value: string): string {
  const lines = value.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/)?.[0] ?? "");
  if (indents.length === 0) return value;
  const common = indents.reduce((shortest, indent) => (indent.length < shortest.length ? indent : shortest));
  if (common.length === 0) return value;
  return lines.map((line) => (line.startsWith(common) ? line.slice(common.length) : line)).join("\n");
}

const TRANSFORMS: readonly { transform: TransformKind; apply: (value: string) => string }[] = [
  { transform: "verbatim", apply: (value) => value },
  { transform: "line-ending", apply: toLf },
  { transform: "indentation", apply: dedent },
  { transform: "trimmed", apply: (value) => value.trim() },
  { transform: "whitespace-collapsed", apply: (value) => collapseInlineWhitespace(value).trim() },
];

function similarityOf(attempted: string, candidate: string): SimilarityBucket {
  if (candidate === attempted) return "identical";
  if (candidate.replace(/\s+/g, "") === attempted.replace(/\s+/g, "")) return "whitespace-only";
  return "different";
}

function lengthBucketOf(attempted: string, candidate: string): LengthBucket {
  if (candidate.length === attempted.length) return "same";
  return candidate.length < attempted.length ? "shorter" : "longer";
}

/** Deterministic, deduplicated, bounded candidate set for one attempted anchor. */
export function generateMismatchCandidates(attemptedOldText: string): MismatchCandidate[] {
  const seen = new Set<string>();
  const candidates: MismatchCandidate[] = [];
  for (const { transform, apply } of TRANSFORMS) {
    const text = apply(attemptedOldText);
    if (text.length === 0) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    candidates.push({
      ordinal: candidates.length + 1,
      transform,
      similarity: similarityOf(attemptedOldText, text),
      lengthBucket: lengthBucketOf(attemptedOldText, text),
      lineCount: Math.min(text.split("\n").length, 99),
      text,
    });
    if (candidates.length === MAX_MISMATCH_CANDIDATES) break;
  }
  return candidates;
}

/** Closed request features for one candidate: ordinal + structural buckets only. */
export function candidateFeatures(candidate: MismatchCandidate): Record<string, string | number> {
  return {
    ordinal: candidate.ordinal,
    transform: candidate.transform,
    similarity: candidate.similarity,
    length: candidate.lengthBucket,
    lines: candidate.lineCount,
  };
}

/** Label ordinal: the candidate identical to the later successful anchor, else undefined. */
export function labelOrdinal(candidates: readonly MismatchCandidate[], successfulOldText: string): number | undefined {
  const match = candidates.find((candidate) => candidate.text === successfulOldText);
  return match?.ordinal;
}
