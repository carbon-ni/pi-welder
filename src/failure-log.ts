/**
 * Failure log — pure logic for the welder extension.
 *
 * A "failure" is a harness-level tool error: malformed tool calls (schema /
 * JSON validation), unknown tools, harness-side read/edit/write failures, or
 * bash spawn failures. We EXCLUDE bash results that ran and returned an
 * exitCode — those are CLI failures, not harness failures.
 *
 * This module has no pi dependencies so it can be unit-tested in isolation.
 */

export type FailureKind = "syntax" | "harness";

export interface Failure {
  id: number;
  timestamp: string; // ISO 8601
  kind: FailureKind;
  toolName: string;
  toolCallId: string;
  cwd: string;
  input: unknown;
  errorContent: string;
  exitCode?: number;
}

export interface FailureLog {
  nextId: number;
  failures: Failure[];
}

/** Input shape we accept from a pi `tool_result` event. Loosely typed on purpose. */
export interface ToolResultInput {
  toolName: string;
  isError: boolean;
  details?: { exitCode?: number } | unknown;
  content: Array<{ type: string; text?: string }>;
}

const SYNTAX_MARKERS = [
  "validation",
  "required",
  "schema",
  "unexpected token",
  "json",
  "parse",
  "invalid",
  "malformed",
  "argument",
  "parameter",
];

/** Decide whether a tool_result is a welder-tracked failure, and what kind. Returns null if not a failure. */
export function classifyFailure(input: ToolResultInput): { kind: FailureKind } | null {
  if (!input.isError) return null;

  // Bash that actually ran (has an exitCode) is a CLI result — excluded.
  if (input.toolName === "bash") {
    const exitCode = (input.details as { exitCode?: number } | undefined)?.exitCode;
    if (exitCode !== undefined) return null;
  }

  const text = joinContent(input.content).toLowerCase();
  const kind: FailureKind = SYNTAX_MARKERS.some((m) => text.includes(m)) ? "syntax" : "harness";
  return { kind };
}

/** Empty log factory. */
export function emptyLog(): FailureLog {
  return { nextId: 1, failures: [] };
}

/** Append a failure immutably. `now` is injectable for deterministic tests. */
export function recordFailure(
  log: FailureLog,
  partial: Omit<Failure, "id" | "timestamp">,
  now: () => string = () => new Date().toISOString(),
): FailureLog {
  const failure: Failure = {
    id: log.nextId,
    timestamp: now(),
    ...partial,
  };
  return {
    nextId: log.nextId + 1,
    failures: [...log.failures, failure],
  };
}

/** Human-readable summary for the `/failures` command. */
export function summarize(log: FailureLog): string {
  if (log.failures.length === 0) return "No failures recorded.";
  const header = `${log.failures.length} failure${log.failures.length === 1 ? "" : "s"}:`;
  const lines = log.failures.map((f) => {
    const snippet = f.errorContent.length > 60 ? `${f.errorContent.slice(0, 57)}...` : f.errorContent;
    return `#${f.id} [${f.kind}] ${f.toolName} — ${snippet}`;
  });
  return [header, ...lines].join("\n");
}

function joinContent(content: ToolResultInput["content"]): string {
  return content
    .map((c) => (c.type === "text" && c.text ? c.text : ""))
    .filter(Boolean)
    .join(" ");
}
