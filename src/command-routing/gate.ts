/**
 * TASK-0034 — exact bash-shaped wrong-tool gate and reason builder.
 *
 * The gate is the frozen TASK-0033 evidence (195/195 unique-schema matches) plus
 * exact deterministic validation. No model call, no Jev, and no rewriting: the
 * command and timeout are executed exactly as the model sent them.
 */

import type { BashExecutionOutcome } from "./types.ts";

/** Only these tools can carry an exact bash shape by mistake. */
export const REROUTE_SOURCE_TOOLS = ["read", "write", "edit"] as const;

/** Pi's bash tool takes seconds; it rejects non-finite, <= 0, and > 2^31-1 ms. */
export const BASH_TIMEOUT_MAX_SECONDS = 2_147_483.647;

/** The reason carries real output; bound it so one call cannot flood the context. */
export const MAX_REASON_OUTPUT_CHARS = 24_000;

export interface BashShapedCall {
  command: string;
  timeout?: number;
}

/**
 * Recognizes a call addressed to `read`/`write`/`edit` whose ORIGINAL input is
 * exactly `command` plus an optional `timeout`. Any other key, an unknown tool,
 * an empty/whitespace command, or an invalid timeout abstains.
 */
export function recognizeBashShapedCall(toolName: string, input: unknown): BashShapedCall | undefined {
  if (!(REROUTE_SOURCE_TOOLS as readonly string[]).includes(toolName)) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.length > 2) return undefined;
  if (!keys.every((key) => key === "command" || key === "timeout")) return undefined;

  const command = record.command;
  if (typeof command !== "string" || command.trim().length === 0) return undefined;

  const timeout = record.timeout;
  if (timeout === undefined) return { command };
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > BASH_TIMEOUT_MAX_SECONDS) return undefined;
  return { command, timeout };
}

function boundOutput(text: string): string {
  if (text.length <= MAX_REASON_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_REASON_OUTPUT_CHARS)}\n\n[pi-welder: output truncated at ${MAX_REASON_OUTPUT_CHARS} characters]`;
}

/**
 * Block reason. It states the block, the executed outcome, and the real output.
 * It never contains the command.
 */
export function buildBashRouteReason(sourceTool: string, outcome: BashExecutionOutcome): string {
  const header = [
    `pi-welder: blocked this ${sourceTool} call because its arguments are an exact bash shape; no ${sourceTool} was applied.`,
    `The identical command ran once through bash and ${outcome.isError ? "failed" : "completed"}.`,
  ];
  const output = boundOutput(outcome.text);
  return output.length === 0 ? header.join("\n") : [...header, "", output].join("\n");
}
