/**
 * TASK-0038 — dedicated Jev classification contract for "is this a bash command?".
 *
 * Own contract, own prompt, own parser. The edit-selection client is never
 * reused or cast, and the request shape is deliberately narrow: the attempted
 * tool, the original safe key, and the candidate string. The candidate content
 * is required because semantic command classification cannot work without it —
 * this is the one documented departure from the value-free rule, and it is
 * limited to that single string. No conversation, source files, results,
 * environment, credentials, or future behavior is ever included.
 */

export const BASH_JUDGMENT_PROMPT = [
  "Classify one string from a malformed tool call as either a shell command or not.",
  "You receive the attempted tool name, the field name, and that field's string value.",
  "Answer bash only when the string is meant to be executed as a shell command.",
  "Answer not-bash for prose, paths, identifiers, code, or anything else.",
].join(" ");

export type BashVerdict = "bash" | "not-bash";

export interface BashJudgmentRequest {
  attemptedTool: string;
  key: string;
  candidate: string;
}

export interface BashJudgmentAnswer {
  verdict: BashVerdict;
  confidence?: number;
}

/** Injected capability. Implementations must be zero-retry and abort-aware. */
export interface BashJudgmentClient {
  judge(request: BashJudgmentRequest, signal?: AbortSignal): Promise<unknown>;
}

export const BASH_JUDGMENT_MAX_MS = 8_000;

export function isBashVerdict(value: unknown): value is BashVerdict {
  return value === "bash" || value === "not-bash";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Hardened parsing of the dedicated answer shape. Accepts the parsed object or
 * its JSON text; anything outside `answers.bash` fails closed.
 */
export function parseBashJudgment(raw: unknown): BashJudgmentAnswer | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return undefined; }
  }
  if (!isRecord(parsed)) return undefined;
  const answers = parsed.answers;
  if (!isRecord(answers)) return undefined;
  const bash = answers.bash;
  if (!isRecord(bash)) return undefined;
  const choice = bash.choice;
  if (!isBashVerdict(choice)) return undefined;
  const confidence = bash.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return undefined;
  return { verdict: choice, ...(confidence === undefined ? {} : { confidence }) };
}
