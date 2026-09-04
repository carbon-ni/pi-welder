/**
 * Failure tracking and explicit diagnostics for recent tool results.
 *
 * This does not block or mutate tools. Automatic context handling records
 * failures for stats and explicit diagnostic commands only.
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
}

export function createRecoveryState(maxFailures = 3): RecoveryState {
  return { failures: [], maxFailures };
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

export function clearRecovery(state: RecoveryState): void {
  state.failures = [];
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
}

function firstLine(value: string): string {
  return truncate(value.split(/\r?\n/)[0] ?? value, 220);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
