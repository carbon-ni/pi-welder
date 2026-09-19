/**
 * TASK-0028 — restore read-shaped `edit` calls.
 *
 * Closed-shape recognition only: an `edit` call whose arguments are exactly a
 * read shape is never a valid edit. Pi 0.85.0 cannot replace tool identity
 * from a `tool_call` handler (see `ToolCallEventResult` — `{ block?, reason? }`
 * only), so the doomed edit is blocked and the block reason carries the exact
 * corrected `read` call. No model call, filesystem pre-read, path rewriting,
 * or content reconstruction happens here.
 */

export interface RestoredReadCall {
  path: string;
  offset?: number;
  limit?: number;
}

/** Keys that make a call an edit, not a read; their presence always abstains. */
const CONTENT_KEYS = ["edits", "oldText", "newText"] as const;
const SHAPE_OFFSET_KEYS: ReadonlySet<string> = new Set(["path", "offset", "limit"]);
const SHAPE_RANGE_KEYS: ReadonlySet<string> = new Set(["path", "startLine", "endLine"]);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Recognizes a read-shaped edit input. Returns the equivalent read call, or
 * undefined for anything ambiguous, mixed, invalid, content-bearing, or
 * unknown. The input is never mutated and the path is passed through verbatim.
 */
export function recognizeReadShapedEdit(input: unknown): RestoredReadCall | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) return undefined;
  if (CONTENT_KEYS.some((key) => key in record)) return undefined;

  const keys = Object.keys(record);
  if (keys.length === 0) return undefined;

  if (keys.every((key) => SHAPE_OFFSET_KEYS.has(key))) {
    const { offset, limit } = record;
    if (offset !== undefined && !isPositiveInteger(offset)) return undefined;
    if (limit !== undefined && !isPositiveInteger(limit)) return undefined;
    return {
      path: record.path,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    };
  }

  if (keys.every((key) => SHAPE_RANGE_KEYS.has(key))) {
    const { startLine, endLine } = record;
    if (!isPositiveInteger(startLine) || !isPositiveInteger(endLine)) return undefined;
    if (endLine < startLine) return undefined;
    return { path: record.path, offset: startLine, limit: endLine - startLine + 1 };
  }

  return undefined;
}

/** Exact corrected read call, deterministic key order. */
export function renderRestoredReadCall(call: RestoredReadCall): string {
  const arguments_: Record<string, unknown> = { path: call.path };
  if (call.offset !== undefined) arguments_.offset = call.offset;
  if (call.limit !== undefined) arguments_.limit = call.limit;
  return JSON.stringify({ name: "read", arguments: arguments_ });
}

/**
 * Block reason: states the edit was not applied and gives one exact corrected
 * read call. No generic advice, no success claim.
 */
export function buildRestoreReadReason(call: RestoredReadCall): string {
  return [
    "pi-welder: blocked this edit because its arguments are a read shape; no edit was applied.",
    `Retry exactly once with the corrected read call: ${renderRestoredReadCall(call)}`,
  ].join("\n");
}
