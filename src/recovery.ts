/**
 * Recovery guidance — turns recent tool failures into compact context hints.
 *
 * This does not block or mutate tools. It observes failing `tool_result` events
 * and injects one short system message on the next model context so the model
 * can recover without repeating the same bad call.
 */

export interface ToolResultLike {
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  content?: unknown;
}

export interface FailureRecord {
  toolName: string;
  inputKeys: string[];
  errorText: string;
  ts: string;
}

export interface RecoveryState {
  failures: FailureRecord[];
  maxFailures: number;
  deliveredSnapshot: string | null;
}

export interface RecoveryMessage {
  role: "system";
  content: string;
}

export function createRecoveryState(maxFailures = 3): RecoveryState {
  return { failures: [], maxFailures, deliveredSnapshot: null };
}

export function extractToolErrorText(result: Pick<ToolResultLike, "isError" | "content">): string {
  if (!result.isError) return "";

  const content = result.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return String(content ?? "").trim();
}

export function recordToolResult(state: RecoveryState, result: ToolResultLike): void {
  const errorText = extractToolErrorText(result);

  if (!errorText) {
    state.failures = state.failures.filter((f) => f.toolName !== result.toolName);
    state.deliveredSnapshot = null;
    return;
  }

  state.failures.push({
    toolName: result.toolName,
    inputKeys: Object.keys(result.input ?? {}),
    errorText: truncate(errorText, 500),
    ts: new Date().toISOString(),
  });

  if (state.failures.length > state.maxFailures) {
    state.failures = state.failures.slice(-state.maxFailures);
  }
  state.deliveredSnapshot = null;
}

export function buildRecoveryGuidance(state: RecoveryState): RecoveryMessage[] {
  if (state.failures.length === 0) return [];

  const lines = [
    "pi-welder recovery hints: recent tool calls failed. Before retrying, change strategy instead of repeating the same call.",
  ];

  for (const failure of state.failures) {
    lines.push(`- ${failure.toolName} failed: ${firstLine(failure.errorText)}`);
    const hint = failureHint(failure.errorText);
    if (hint) lines.push(`  hint: ${hint}`);
    if (failure.inputKeys.length > 0) lines.push(`  input keys: ${failure.inputKeys.join(", ")}`);
  }

  return [{ role: "system", content: lines.join("\n") }];
}

export function recoveryFailuresSummary(state: RecoveryState): string {
  if (state.failures.length === 0) return "pi-welder: no pending recovery failures";

  const lines = ["pi-welder pending recovery failures"];
  for (const failure of state.failures) {
    lines.push(`- ${failure.toolName} failed: ${firstLine(failure.errorText)}`);
    if (failure.inputKeys.length > 0) lines.push(`  input keys: ${failure.inputKeys.join(", ")}`);
  }
  return lines.join("\n");
}

export function consumeRecoveryGuidance(state: RecoveryState): RecoveryMessage[] {
  const snapshot = recoverySnapshot(state);
  if (!snapshot || snapshot === state.deliveredSnapshot) return [];
  const messages = buildRecoveryGuidance(state);
  if (messages.length > 0) state.deliveredSnapshot = snapshot;
  return messages;
}

export function clearRecovery(state: RecoveryState): void {
  state.failures = [];
  state.deliveredSnapshot = null;
}

export function setRecoveryLimit(state: RecoveryState, limit: number): void {
  if (!Number.isInteger(limit)) {
    throw new Error("recovery limit must be an integer");
  }
  if (limit < 1 || limit > 10) {
    throw new Error("recovery limit must be between 1 and 10");
  }

  state.maxFailures = limit;
  state.failures = state.failures.slice(-limit);
  state.deliveredSnapshot = null;
}

function firstLine(value: string): string {
  return truncate(value.split(/\r?\n/)[0] ?? value, 220);
}

function failureHint(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes("current context edits[") || lower.includes("fresh context read from ")) {
    return "retry with exact oldText from included context.";
  }
  if (lower.includes("edit_mismatch") || lower.includes("oldtext") || lower.includes("not found")) {
    return "read a fresh snippet, then retry with exact oldText from the current file.";
  }
  if (lower.includes("enoent") || lower.includes("no such file") || lower.includes("not a directory")) {
    return "verify the path from the current workspace before retrying.";
  }
  if (lower.includes("schema") || lower.includes("invalid") || lower.includes("expected")) {
    return "fix argument shape/types before retrying; do not repeat identical JSON.";
  }
  return "inspect the failure and retry with changed arguments.";
}

function recoverySnapshot(state: RecoveryState): string {
  if (state.failures.length === 0) return "";
  return state.failures
    .map((f) => [f.toolName, f.ts, f.errorText].join("\0"))
    .join("\0\0");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
