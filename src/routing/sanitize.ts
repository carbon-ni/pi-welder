/**
 * TASK-0021 — routing sanitizer. Error text can embed absolute paths, source
 * lines, commands, and secrets; every routed case must be reduced to a shape
 * that carries none of them. Cases that cannot be sanitized drop out.
 */

import { redactShadowText } from "../model-recovery/ambiguous-shadow.ts";

export const MAX_ROUTING_TEXT_BYTES = 512;

/** Path-like token: drive letters, POSIX absolute, or multi-segment relative. */
const PATH_TOKEN = /(?:[A-Za-z]:)?(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*/g;
const QUOTED = /(['"`])(?:[^'"`\\]|\\.)*\1/g;
const SOURCE_LINE = /\b(?:import|export|const|let|var|function|return|class)\b[^\n]*/g;
const CODE_FENCE = /```[\s\S]*?```/g;

/**
 * Redacts an error string for routing: credentials (existing shadow sanitizer),
 * paths, quoted values, and source-like lines. Returns undefined when the
 * input is unsanitizable (control characters) or empty after redaction.
 */
export function sanitizeRoutingText(errorText: string): string | undefined {
  const credentialSafe = redactShadowText(errorText);
  if (credentialSafe === undefined) return undefined;

  const redacted = credentialSafe
    .replace(CODE_FENCE, "<code>")
    .replace(QUOTED, "<value>")
    .replace(SOURCE_LINE, "<source>")
    .replace(PATH_TOKEN, "<path>")
    .replace(/\s+/g, " ")
    .trim();

  if (redacted.length === 0) return undefined;
  const capped = redacted.slice(0, MAX_ROUTING_TEXT_BYTES);
  return capped.length === 0 ? undefined : capped;
}

/** A closed routing case: sanitized metadata only. */
export interface RoutingState {
  toolName: string;
  errorKind: string;
  errorText: string;
}

export function buildRoutingState(input: { toolName: string; errorKind?: string; errorText: string }): RoutingState | undefined {
  const errorText = sanitizeRoutingText(input.errorText);
  if (errorText === undefined) return undefined;
  return {
    toolName: input.toolName,
    errorKind: input.errorKind ?? "unknown",
    errorText,
  };
}
