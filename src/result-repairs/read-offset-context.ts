import { nodeFileSystem, type FileSystem } from "../infra/filesystem.ts";
import { resolveReadPath } from "./directory-read.ts";
import type { ToolResultShape } from "./types.ts";

const DEFAULT_PAGE_LINES = 200;
const MAX_PAGE_LINES = 200;
const MAX_RESULT_BYTES = 5_000;
const MAX_DISPLAY_PATH_BYTES = 500;
const OFFSET_ERROR = /^Offset (\d+) is beyond end of file \((\d+) lines total\)$/;

export interface ReadOffsetContextResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    readOffsetContext: {
      path: string;
      requestedOffset: number;
      requestedLimit: number;
      actualOffset: number;
      returnedLines: number;
      totalLines: number;
      truncated: boolean;
    };
  };
  isError: false;
}

interface ReadOffsetRequest {
  path: string;
  requestedOffset: number;
  requestedLimit: number;
  totalLines: number;
}

export async function recoverReadOffsetContext(
  event: ToolResultShape,
  cwd: string,
  fileSystem: FileSystem = nodeFileSystem,
): Promise<ReadOffsetContextResult | undefined> {
  const request = parseReadOffsetRequest(event);
  if (!request) return undefined;

  const current = await fileSystem.readFile(resolveReadPath(request.path, cwd)).catch(() => undefined);
  if (current === undefined) return undefined;

  const lines = splitFileLines(current);
  if (lines.length !== request.totalLines) return undefined;

  const selected = selectBoundedTail(
    lines,
    Math.min(request.requestedLimit, MAX_PAGE_LINES),
    request.path,
    request.requestedOffset,
  );
  const truncated = request.requestedLimit > MAX_PAGE_LINES || selected.truncated;
  return {
    content: [{ type: "text", text: selected.text }],
    details: {
      readOffsetContext: {
        path: request.path,
        requestedOffset: request.requestedOffset,
        requestedLimit: request.requestedLimit,
        actualOffset: selected.actualOffset,
        returnedLines: selected.returnedLines,
        totalLines: lines.length,
        truncated,
      },
    },
    isError: false,
  };
}

function parseReadOffsetRequest(event: ToolResultShape): ReadOffsetRequest | undefined {
  if (!isFailedRead(event)) return undefined;

  const error = parseOffsetError(extractText(event.content));
  if (!error) return undefined;
  if (error.totalLines < 1) return undefined;

  const input = parseReadInput(event.input, error.requestedOffset);
  if (!input) return undefined;
  return { ...input, totalLines: error.totalLines };
}

function isFailedRead(event: ToolResultShape): boolean {
  return event.toolName === "read" && event.isError === true;
}

function parseReadInput(
  input: Record<string, unknown> | undefined,
  errorOffset: number,
): Omit<ReadOffsetRequest, "totalLines"> | undefined {
  if (!input) return undefined;

  const path = input.path;
  if (typeof path !== "string") return undefined;

  const requestedOffset = input.offset;
  if (typeof requestedOffset !== "number" || !Number.isSafeInteger(requestedOffset)) return undefined;
  if (requestedOffset !== errorOffset) return undefined;

  const requestedLimit = resolveRequestedLimit(input.limit);
  if (!requestedLimit) return undefined;
  return { path, requestedOffset, requestedLimit };
}

function resolveRequestedLimit(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_PAGE_LINES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function parseOffsetError(value: string): { requestedOffset: number; totalLines: number } | undefined {
  const match = OFFSET_ERROR.exec(value);
  if (!match) return undefined;
  const requestedOffset = Number(match[1]);
  const totalLines = Number(match[2]);
  if (!Number.isSafeInteger(requestedOffset) || !Number.isSafeInteger(totalLines)) return undefined;
  return { requestedOffset, totalLines };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || !("text" in item)) return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function selectBoundedTail(
  allLines: string[],
  lineLimit: number,
  path: string,
  requestedOffset: number,
): { text: string; actualOffset: number; returnedLines: number; truncated: boolean } {
  const selected = allLines.slice(-lineLimit);
  let truncated = false;

  while (selected.length > 1) {
    const text = renderResult(path, requestedOffset, allLines.length, selected);
    if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) {
      return {
        text,
        actualOffset: allLines.length - selected.length + 1,
        returnedLines: selected.length,
        truncated,
      };
    }
    selected.shift();
    truncated = true;
  }

  const actualOffset = allLines.length;
  const header = renderHeader(path, requestedOffset, allLines.length, actualOffset, actualOffset);
  const contentBudget = Math.max(0, MAX_RESULT_BYTES - Buffer.byteLength(`${header}\n\n`, "utf8"));
  const line = truncateUtf8Tail(selected[0] ?? "", contentBudget);
  if (line !== selected[0]) truncated = true;
  return {
    text: `${header}\n\n${line}`,
    actualOffset,
    returnedLines: selected.length,
    truncated,
  };
}

function renderResult(path: string, requestedOffset: number, totalLines: number, lines: string[]): string {
  const actualOffset = totalLines - lines.length + 1;
  const header = renderHeader(path, requestedOffset, totalLines, actualOffset, totalLines);
  return `${header}\n\n${lines.join("\n")}`;
}

function renderHeader(path: string, requestedOffset: number, totalLines: number, start: number, end: number): string {
  const displayPath = truncateUtf8Tail(path, MAX_DISPLAY_PATH_BYTES);
  return `Read recovered from ${displayPath}: requested offset ${requestedOffset} exceeded ${totalLines} lines. Showing lines ${start}-${end}.`;
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 3) return "";

  const bytes = Buffer.from(value, "utf8");
  let suffix = bytes.subarray(bytes.length - (maxBytes - 3)).toString("utf8").replace(/^\uFFFD+/u, "");
  while (Buffer.byteLength(suffix, "utf8") > maxBytes - 3) suffix = suffix.slice(1);
  return `…${suffix}`;
}
