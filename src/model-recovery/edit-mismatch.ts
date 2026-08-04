import { resolve } from "node:path";
import { nodeFileSystem, type FileSystem } from "../infra/filesystem.ts";
import { whitespaceNormalizedOffsets } from "./whitespace-normalized.ts";

interface EditInput { oldText: string; newText: string }

/**
 * Deterministic preflight: before the built-in `edit` tool runs, expand
 * ambiguous `oldText` values (multiple occurrences) to unique surrounding
 * context so the edit lands in exactly one place.
 *
 * Edits whose `oldText` has zero occurrences cannot be located without an
 * external reasoner; this preflight abstains on those and leaves them for the
 * deterministic edit-failure-context path. The repair is all-or-nothing: if any
 * pending edit cannot be resolved locally, nothing is mutated.
 */
export async function preflightEditMismatch(input: {
  toolInput: Record<string, unknown>;
  cwd: string;
  fileSystem?: FileSystem;
}): Promise<{ repairedEdits: number } | undefined> {
  const target = input.toolInput.path;
  const edits = parseEdits(input.toolInput.edits);
  if (typeof target !== "string" || edits.length === 0) return undefined;

  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const current = await fileSystem.readFile(resolve(input.cwd, target)).catch(() => undefined);
  if (current === undefined || current.length > 200_000) return undefined;

  const pending = edits
    .map((edit, index) => ({ ...edit, index }))
    .filter(({ oldText, newText }) => countOccurrences(current, oldText) !== 1 && !current.includes(newText));
  if (pending.length === 0) return undefined;

  const local = resolveAmbiguousEdits(current, edits, pending);
  if (!local) return undefined;

  // Missing edits (zero exact occurrences) get one deterministic retry:
  // a unique whitespace-normalized match. Edits that stay missing abort the
  // whole repair, so the edit fails cleanly and the deterministic
  // failure-context path can attach fresh file context.
  const missing = resolveMissingEdits(current, edits, pending, local);
  if (!missing) return undefined;

  const repairedEdits = edits.map((edit) => ({ ...edit }));
  for (const repair of [...local, ...missing]) {
    repairedEdits[repair.index]!.oldText = repair.oldText;
    repairedEdits[repair.index]!.newText = repair.newText;
  }
  if (!haveNonOverlappingUniqueTargets(current, repairedEdits)) return undefined;

  input.toolInput.edits = repairedEdits;
  return { repairedEdits: local.length + missing.length };
}

function parseEdits(value: unknown): EditInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is EditInput => Boolean(item && typeof item === "object" && typeof item.oldText === "string" && typeof item.newText === "string"));
}

function countOccurrences(content: string, value: string): number {
  return occurrenceOffsets(content, value).length;
}

function occurrenceOffsets(content: string, value: string): number[] {
  if (!value) return [];
  const offsets: number[] = [];
  for (let from = 0; (from = content.indexOf(value, from)) !== -1; from += value.length) offsets.push(from);
  return offsets;
}

interface TextRange { start: number; end: number }
interface LocalRepair { index: number; oldText: string; newText: string; range: TextRange }

function resolveAmbiguousEdits(
  current: string,
  edits: EditInput[],
  pending: Array<EditInput & { index: number }>,
): LocalRepair[] | undefined {
  const uniqueRanges = edits.flatMap((edit, index) => {
    const offsets = occurrenceOffsets(current, edit.oldText);
    return offsets.length === 1 ? [{ index, start: offsets[0]!, end: offsets[0]! + edit.oldText.length }] : [];
  });
  const repairs: LocalRepair[] = [];

  for (const edit of pending) {
    const offsets = occurrenceOffsets(current, edit.oldText);
    if (offsets.length < 2) continue;
    const protectedRanges = [
      ...uniqueRanges.filter(({ index }) => index !== edit.index),
      ...repairs.map(({ index, range }) => ({ index, ...range })),
    ];
    const candidates = offsets.flatMap((start) => {
      const originalRange = { start, end: start + edit.oldText.length };
      if (protectedRanges.some((range) => rangesOverlap(originalRange, range))) return [];
      const expanded = findUniqueExpansion(current, edit.oldText, start);
      if (!expanded || protectedRanges.some((range) => rangesOverlap(expanded, range))) return [];
      const prefix = current.slice(expanded.start, start);
      const suffix = current.slice(start + edit.oldText.length, expanded.end);
      return [{ index: edit.index, oldText: current.slice(expanded.start, expanded.end), newText: prefix + edit.newText + suffix, range: expanded }];
    });
    if (candidates.length !== 1) return undefined;
    repairs.push(candidates[0]!);
  }
  return repairs;
}

/**
 * Resolve zero-occurrence oldText values via a unique whitespace-normalized
 * match. oldText becomes the verbatim file slice; newText stays byte-identical
 * (content-safe: only the locator changes, never the intended replacement).
 * Returns undefined when any missing edit cannot be uniquely located.
 */
function resolveMissingEdits(
  current: string,
  edits: EditInput[],
  pending: Array<EditInput & { index: number }>,
  resolved: LocalRepair[],
): LocalRepair[] | undefined {
  const missing = pending.filter(({ oldText }) => countOccurrences(current, oldText) === 0);
  if (missing.length === 0) return [];

  const protectedRanges = [
    ...edits.flatMap((edit, index) => {
      const offsets = occurrenceOffsets(current, edit.oldText);
      return offsets.length === 1 ? [{ start: offsets[0]!, end: offsets[0]! + edit.oldText.length }] : [];
    }),
    ...resolved.map(({ range }) => range),
  ];

  const repairs: LocalRepair[] = [];
  for (const edit of missing) {
    const matches = whitespaceNormalizedOffsets(current, edit.oldText)
      .filter((range) => !protectedRanges.some((range2) => rangesOverlap(range, range2))
        && !repairs.some(({ range: range2 }) => rangesOverlap(range, range2)));
    if (matches.length !== 1) return undefined;
    const range = matches[0]!;
    repairs.push({ index: edit.index, oldText: current.slice(range.start, range.end), newText: edit.newText, range });
  }
  return repairs;
}

function findUniqueExpansion(current: string, oldText: string, start: number): TextRange | undefined {
  const end = start + oldText.length;
  const leftExtra = findMinimumUniqueExtra(start, (extra) => current.slice(start - extra, end), current);
  const rightExtra = findMinimumUniqueExtra(current.length - end, (extra) => current.slice(start, end + extra), current);
  if (leftExtra === undefined && rightExtra === undefined) return undefined;
  if (rightExtra !== undefined && (leftExtra === undefined || rightExtra <= leftExtra)) return { start, end: end + rightExtra };
  return { start: start - leftExtra!, end };
}

function findMinimumUniqueExtra(maxExtra: number, candidateAt: (extra: number) => string, current: string): number | undefined {
  if (maxExtra === 0) return undefined;
  let high = 1;
  while (high < maxExtra && countOccurrences(current, candidateAt(high)) !== 1) high = Math.min(maxExtra, high * 2);
  if (countOccurrences(current, candidateAt(high)) !== 1) return undefined;
  let low = 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (countOccurrences(current, candidateAt(middle)) === 1) high = middle;
    else low = middle + 1;
  }
  return low;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function haveNonOverlappingUniqueTargets(current: string, edits: EditInput[]): boolean {
  const ranges: TextRange[] = [];
  for (const edit of edits) {
    const offsets = occurrenceOffsets(current, edit.oldText);
    if (offsets.length !== 1) continue;
    const range = { start: offsets[0]!, end: offsets[0]! + edit.oldText.length };
    if (ranges.some((existing) => rangesOverlap(existing, range))) return false;
    ranges.push(range);
  }
  return true;
}
