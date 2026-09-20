/**
 * TASK-0031 — exact-text edit mismatch episodes.
 *
 * Pure extraction: a failing `edit` whose exact-text anchor is not found,
 * followed within three tool calls by a successful `edit` on the same path,
 * with no intervening user message or successful mutation. The later successful
 * edit is used ONLY as a local label; it is never request input.
 */

export interface EditEvent {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  toolCallId?: string;
  path?: string;
  /** First edit anchor; in-memory only. */
  oldText?: string;
  newText?: string;
  isError?: boolean;
  errorText?: string;
}

export const FOLLOWING_CALL_WINDOW = 3;
/** Pre-failure intent signals come from at most this many prior events. */
export const PRIOR_EVENT_WINDOW = 3;

export interface ClosedPriorSignals {
  priorEditAttempts: number;
  priorErrorCalls: number;
  priorOkCalls: number;
}

export interface MismatchCase {
  caseId: string;
  sessionId: string;
  /** In-memory input; never transmitted. */
  attemptedOldText: string;
  /** In-memory label only; never transmitted. */
  successfulOldText: string;
  failureClass: "edit.oldtext-not-found";
  prior: ClosedPriorSignals;
}

function isNotFoundEdit(event: EditEvent): boolean {
  if (event.toolName !== "edit" || event.isError !== true) return false;
  const text = (event.errorText ?? "").toLowerCase();
  return (text.includes("could not find") || text.includes("must match exactly")) && !text.includes("occurrences");
}

function isSuccessfulMutation(event: EditEvent): boolean {
  return event.isError === false && (event.toolName === "edit" || event.toolName === "write");
}

/**
 * Extracts labelable mismatch cases with bounded, closed pre-failure signals.
 * Paths are compared in memory only; nothing here is rendered or transmitted.
 */
export function extractMismatchCases(sessionId: string, events: readonly EditEvent[]): MismatchCase[] {
  const resultByCall = new Map<string, EditEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") resultByCall.set(event.toolCallId, event);
  }

  const cases: MismatchCase[] = [];

  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;

    const result = typeof call.toolCallId === "string" ? resultByCall.get(call.toolCallId) : undefined;
    if (result?.isError === true && isNotFoundEdit({ ...call, isError: true, errorText: result.errorText })) {
      const attemptedOldText = call.oldText;
      if (typeof attemptedOldText === "string" && attemptedOldText.length > 0) {
        const success = findRecovery(events, index, call);
        if (success) {
          cases.push({
            caseId: `${sessionId}#${call.toolCallId ?? call.id}`,
            sessionId,
            attemptedOldText,
            successfulOldText: success.oldText!,
            failureClass: "edit.oldtext-not-found",
            prior: boundedPriorSignals(events, index),
          });
        }
      }
    }
  }
  return cases;
}

/**
 * Pre-failure signals from at most three events physically before the failed
 * call. Nothing at or after the failed call can enter these counters, so a
 * result that lands later under parallel ordering never leaks forward.
 */
export function boundedPriorSignals(events: readonly EditEvent[], callIndex: number): ClosedPriorSignals {
  const window = events.slice(Math.max(0, callIndex - PRIOR_EVENT_WINDOW), callIndex);
  return {
    priorEditAttempts: window.filter((event) => event.kind === "toolCall" && event.toolName === "edit").length,
    priorErrorCalls: window.filter((event) => event.kind === "toolResult" && event.isError === true).length,
    priorOkCalls: window.filter((event) => event.kind === "toolResult" && event.isError === false).length,
  };
}

/** Finds the successful same-path edit within the bounded call window. */
function findRecovery(events: readonly EditEvent[], failureIndex: number, failedCall: EditEvent): { oldText?: string } | undefined {
  const resultByCall = new Map<string, EditEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") resultByCall.set(event.toolCallId, event);
  }
  let callsSeen = 0;
  for (let index = failureIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") return undefined; // user intervention ends recovery search
    if (event.kind !== "toolCall" || typeof event.toolName !== "string") continue;
    callsSeen++;
    if (callsSeen > FOLLOWING_CALL_WINDOW) return undefined;

    const result = typeof event.toolCallId === "string" ? resultByCall.get(event.toolCallId) : undefined;
    if (result?.isError === true) continue;
    if (result === undefined) continue;
    if (!isSuccessfulMutation({ ...event, isError: false })) continue;

    if (event.toolName !== "edit") return undefined; // a successful non-edit mutation
    if (event.path !== failedCall.path) return undefined; // mutation on a different path
    if (typeof event.oldText === "string" && event.oldText.length > 0) return { oldText: event.oldText };
    return undefined;
  }
  return undefined;
}
