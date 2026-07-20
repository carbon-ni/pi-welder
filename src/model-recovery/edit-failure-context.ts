import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractToolErrorText, type ToolResultLike } from "../recovery.ts";

const MAX_FILE_BYTES = 200_000;
const MAX_CONTEXT_BYTES = 4_000;
const MAX_EXCERPT_BYTES = 1_200;
const MAX_CANDIDATES = 3;
const CONTEXT_LINE_RADIUS = 3;

interface EditInput { oldText: string; newText: string }

export interface EditFailureContextPatch {
  content: Array<{ type: "text"; text: string }>;
  details: {
    failureContext: {
      path: string;
      editIndexes: number[];
      candidateSections: number;
      truncated: boolean;
    };
  };
  isError: true;
}

interface LocatedSection {
  offset: number;
  endOffset: number;
}

export async function appendEditFailureContext(
  event: ToolResultLike,
  cwd: string,
): Promise<EditFailureContextPatch | undefined> {
  if (event.toolName !== "edit" || !event.isError) return undefined;

  const errorText = extractToolErrorText(event);
  if (!isEditMismatch(errorText)) return undefined;

  const target = event.input?.path;
  const edits = parseEdits(event.input?.edits);
  if (typeof target !== "string" || edits.length === 0) return undefined;

  const current = await readFile(resolve(cwd, target), "utf8").catch(() => undefined);
  if (current === undefined || Buffer.byteLength(current, "utf8") > MAX_FILE_BYTES) return undefined;

  const editIndexes = failedEditIndexes(errorText, edits, current);
  if (editIndexes.length === 0) return undefined;

  const sections = editIndexes.flatMap((editIndex) => {
    const edit = edits[editIndex];
    if (!edit) return [];
    return locateSections(current, edit).map((section) => ({ ...section, editIndex }));
  });
  if (sections.length === 0) return undefined;

  const selected = sections.slice(0, MAX_CANDIDATES);
  const contexts = selected
    .map((section) => ({ ...section, range: excerptRange(current, section.offset, section.endOffset) }))
    .reduce<Array<ReturnType<typeof excerptRange> & { editIndex: number }>>((merged, context) => {
      const overlapping = merged.find((candidate) => (
        candidate.editIndex === context.editIndex
        && candidate.startOffset <= context.range.endOffset
        && context.range.startOffset <= candidate.endOffset
      ));
      if (!overlapping) {
        merged.push({ editIndex: context.editIndex, ...context.range });
        return merged;
      }
      overlapping.startOffset = Math.min(overlapping.startOffset, context.range.startOffset);
      overlapping.endOffset = Math.max(overlapping.endOffset, context.range.endOffset);
      overlapping.startLine = Math.min(overlapping.startLine, context.range.startLine);
      overlapping.endLine = Math.max(overlapping.endLine, context.range.endLine);
      return merged;
    }, []);
  const blocks: string[] = [];
  let excerptWasTruncated = false;

  for (const context of contexts) {
    const rawExcerpt = current.slice(context.startOffset, context.endOffset);
    if (Buffer.byteLength(rawExcerpt, "utf8") > MAX_EXCERPT_BYTES) excerptWasTruncated = true;
    blocks.push(
      "",
      `Current context edits[${context.editIndex}], lines ${context.startLine}-${context.endLine}:`,
      truncateUtf8(rawExcerpt, MAX_EXCERPT_BYTES),
    );
  }

  const omitted = sections.length - selected.length;
  if (omitted > 0) blocks.push("", `… ${omitted} more matches.`);

  const rendered = truncateUtf8(blocks.join("\n"), MAX_CONTEXT_BYTES);
  return {
    content: [{ type: "text", text: rendered }],
    details: {
      failureContext: {
        path: target,
        editIndexes,
        candidateSections: sections.length,
        truncated: omitted > 0 || excerptWasTruncated || Buffer.byteLength(blocks.join("\n"), "utf8") > MAX_CONTEXT_BYTES,
      },
    },
    isError: true,
  };
}

function isEditMismatch(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  const mentionsTarget = lower.includes("oldtext") || lower.includes("old text") || lower.includes("exact text") || lower.includes("occurrences of the text");
  return mentionsTarget && (lower.includes("could not find") || lower.includes("not found") || lower.includes("must match") || lower.includes("must be unique") || lower.includes("occurrences"));
}

function parseEdits(value: unknown): EditInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is EditInput => Boolean(
    item && typeof item === "object"
    && typeof (item as EditInput).oldText === "string"
    && typeof (item as EditInput).newText === "string",
  ));
}

function failedEditIndexes(errorText: string, edits: EditInput[], current: string): number[] {
  const indexed = [...errorText.matchAll(/edits\[(\d+)]/gi)]
    .map((match) => Number(match[1]))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < edits.length);
  if (indexed.length > 0) return [...new Set(indexed)];
  if (edits.length === 1) return [0];

  return edits.flatMap((edit, index) => {
    const occurrences = occurrenceOffsets(current, edit.oldText).length;
    return occurrences !== 1 && !current.includes(edit.newText) ? [index] : [];
  });
}

function locateSections(current: string, edit: EditInput): LocatedSection[] {
  const exact = occurrenceOffsets(current, edit.oldText);
  if (exact.length > 0) {
    return exact.map((offset) => ({
      offset,
      endOffset: offset + edit.oldText.length,
    }));
  }

  const normalized = whitespaceNormalizedOffsets(current, edit.oldText);
  if (normalized.length > 0) {
    return normalized.map(({ start, end }) => ({
      offset: start,
      endOffset: end,
    }));
  }

  const likelyOffset = likelyLineOffset(current, `${edit.oldText}\n${edit.newText}`);
  if (likelyOffset !== undefined) {
    return [{ offset: likelyOffset, endOffset: likelyOffset }];
  }

  if (Buffer.byteLength(current, "utf8") <= MAX_EXCERPT_BYTES) {
    return [{ offset: 0, endOffset: current.length }];
  }
  return [];
}

function occurrenceOffsets(content: string, value: string): number[] {
  if (!value) return [];
  const offsets: number[] = [];
  for (let from = 0; (from = content.indexOf(value, from)) !== -1; from += Math.max(1, value.length)) offsets.push(from);
  return offsets;
}

function whitespaceNormalizedOffsets(content: string, target: string): Array<{ start: number; end: number }> {
  const compactTarget = target.replace(/\s+/g, "");
  if (compactTarget.length < 8) return [];

  let compactCurrent = "";
  const sourceOffsets: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (/\s/.test(content[index]!)) continue;
    compactCurrent += content[index];
    sourceOffsets.push(index);
  }

  return occurrenceOffsets(compactCurrent, compactTarget).map((offset) => ({
    start: sourceOffsets[offset]!,
    end: (sourceOffsets[offset + compactTarget.length - 1] ?? sourceOffsets[offset]!) + 1,
  }));
}

function likelyLineOffset(current: string, target: string): number | undefined {
  const targetTokens = new Set(tokens(target));
  if (targetTokens.size === 0) return undefined;

  let best: { offset: number; score: number; matched: number } | undefined;
  let offset = 0;
  for (const line of current.split("\n")) {
    const lineTokens = new Set(tokens(line));
    const shared = [...lineTokens].filter((token) => targetTokens.has(token));
    const score = shared.reduce((total, token) => total + token.length, 0);
    if (score > (best?.score ?? 0) || (score === best?.score && shared.length > (best?.matched ?? 0))) {
      best = { offset, score, matched: shared.length };
    }
    offset += line.length + 1;
  }

  if (!best || best.score < 12 || (best.matched < 2 && best.score < 18)) return undefined;
  return best.offset;
}

function tokens(value: string): string[] {
  return [...value.matchAll(/[A-Za-z_$][A-Za-z0-9_$.-]{2,}/g)].map((match) => match[0]!);
}

function excerptRange(content: string, startOffset: number, endOffset: number): {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
} {
  const lines = content.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const firstLineIndex = lineIndexAt(starts, startOffset);
  const lastLineIndex = lineIndexAt(starts, Math.max(startOffset, endOffset - 1));
  const startLineIndex = Math.max(0, firstLineIndex - CONTEXT_LINE_RADIUS);
  const endLineIndex = Math.min(lines.length - 1, lastLineIndex + CONTEXT_LINE_RADIUS);
  return {
    startOffset: starts[startLineIndex]!,
    endOffset: endLineIndex + 1 < starts.length ? starts[endLineIndex + 1]! - 1 : content.length,
    startLine: startLineIndex + 1,
    endLine: endLineIndex + 1,
  };
}

function lineIndexAt(starts: number[], target: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  const truncated = buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD$/u, "");
  return `${truncated}…`;
}
