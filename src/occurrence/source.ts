/**
 * TASK-0032 — deterministic occurrence candidates for non-unique edits.
 *
 * For each occurrence of the failed anchor, the smallest prefix/suffix
 * extension that is unique in the source snapshot. Construction never
 * generates replacement content: the replacement reuses the failed `newText`
 * with the identical untouched prefix/suffix. A following read may reconstruct
 * the environment only when no user event or mutation precedes it; it is never
 * used as an intent signal.
 */

export const MAX_OCCURRENCES = 5;

export type ContextLengthBucket = "short" | "medium" | "long";
export type PositionBucket = "first" | "middle" | "last";

export interface OccurrenceCandidate {
  ordinal: number;
  /** Unique-in-source anchor (extension of the failed anchor). */
  oldText: string;
  /** Same replacement with the untouched prefix/suffix preserved. */
  newText: string;
  /** Undefined when no extension inside the bound is unique. */
  unique: boolean;
  contextChars: number;
  contextBucket: ContextLengthBucket;
  position: PositionBucket;
  startOffset: number;
}

export function occurrenceOffsets(source: string, anchor: string): number[] {
  if (anchor.length === 0) return [];
  const offsets: number[] = [];
  for (let from = 0; (from = source.indexOf(anchor, from)) !== -1; from += anchor.length) offsets.push(from);
  return offsets;
}

function contextBucketOf(chars: number): ContextLengthBucket {
  if (chars <= 40) return "short";
  if (chars <= 120) return "medium";
  return "long";
}

function positionBucket(index: number, total: number): PositionBucket {
  if (index === 0) return "first";
  if (index === total - 1) return "last";
  return "middle";
}

/** Minimal unique extension of one occurrence; undefined when not unique in bound. */
function uniqueExtension(source: string, start: number, end: number, maxContext: number): { start: number; end: number } | undefined {
  for (let total = 1; total <= maxContext; total++) {
    for (let left = 0; left <= total; left++) {
      const right = total - left;
      const from = Math.max(0, start - left);
      const to = Math.min(source.length, end + right);
      const candidate = source.slice(from, to);
      if (candidate.length === 0) continue;
      if (occurrenceOffsets(source, candidate).length === 1) return { start: from, end: to };
    }
  }
  return undefined;
}

/**
 * Builds one candidate per occurrence (bounded to five), with the identical
 * untouched prefix/suffix applied to the replacement. Deterministic.
 */
export function buildOccurrenceCandidates(source: string, anchor: string, replacement: string, maxContext = 400): OccurrenceCandidate[] {
  const offsets = occurrenceOffsets(source, anchor).slice(0, MAX_OCCURRENCES);
  return offsets.map((start, index) => {
    const end = start + anchor.length;
    const extension = uniqueExtension(source, start, end, maxContext);
    const oldText = extension ? source.slice(extension.start, extension.end) : anchor;
    const prefix = extension ? source.slice(extension.start, start) : "";
    const suffix = extension ? source.slice(end, extension.end) : "";
    return {
      ordinal: index + 1,
      oldText,
      newText: prefix + replacement + suffix,
      unique: extension !== undefined,
      contextChars: prefix.length + suffix.length,
      contextBucket: contextBucketOf(prefix.length + suffix.length),
      position: positionBucket(index, offsets.length),
      startOffset: start,
    };
  });
}

export interface ConstructionProof {
  exactlyOneOccurrenceChanges: boolean;
  untouchedContextIdentical: boolean;
  replacementNeverGenerated: boolean;
}

/**
 * Proves a candidate is mutation-safe: exactly one occurrence changes, the
 * untouched prefix/suffix are byte-identical in anchor and replacement, and
 * the replacement is the caller's text (never generated).
 */
export function proveConstruction(candidate: OccurrenceCandidate, anchor: string, replacement: string, source: string): ConstructionProof {
  const anchorAt = candidate.oldText.indexOf(anchor);
  const replacementAt = candidate.newText.indexOf(replacement);
  const exactlyOneOccurrenceChanges = anchorAt !== -1 && occurrenceOffsets(source, candidate.oldText).length === 1;

  const untouchedContextIdentical = anchorAt !== -1 && replacementAt !== -1
    && candidate.oldText.slice(0, anchorAt) === candidate.newText.slice(0, replacementAt)
    && candidate.oldText.slice(anchorAt + anchor.length) === candidate.newText.slice(replacementAt + replacement.length);

  const replacementNeverGenerated = replacementAt !== -1
    && candidate.newText.split(replacement).length === 2
    && candidate.newText.replace(replacement, "") === candidate.oldText.replace(anchor, "");

  return { exactlyOneOccurrenceChanges, untouchedContextIdentical, replacementNeverGenerated };
}
