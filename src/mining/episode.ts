/**
 * TASK-0030 — bounded failure-and-recovery episode mining (metadata only).
 *
 * Pure and deterministic: identical event streams produce identical episodes
 * in identical order. It never labels intent; recovery shapes and linkage
 * signals are structural observations only.
 */

import { classifyErrorKind } from "../recorder/events.ts";

export const PRIOR_LIMIT = 3;
export const FOLLOWING_LIMIT = 3;

/** Allowlist patterns for every token that reaches the shared report. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
export const ERROR_KIND_PATTERN = /^[A-Z][A-Z0-9_]{0,40}$/;
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_.:|+-]{1,120}$/;

/**
 * Closed vocabulary of failure kinds that may appear in a shared report.
 * `classifyErrorKind` echoes the first uppercase token of arbitrary error text,
 * so membership (not just shape) is required to stop stray prompt text.
 */
export const KNOWN_ERROR_KINDS: ReadonlySet<string> = new Set([
  "TOOL_ERROR", "SCHEMA", "ENOENT", "EISDIR", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EOPNOTSUPP",
  "EDIT_EMPTY_ANCHOR", "EDIT_INVALID_SHAPE", "EDIT_NOOP", "EDIT_OVERLAP", "EDIT_NOT_UNIQUE", "EDIT_NOT_FOUND", "EDIT_MISMATCH",
  "TAP", "NX", "RUN", "STALE", "FAIL", "ABORT", "TIMEOUT", "UNKNOWN",
]);

/**
 * Allowlists a token, or replaces it with `fallback`. Malformed or untrusted
 * values (e.g. a tool name carrying prompt/conversation fragments) must never
 * reach a shared artifact as raw text.
 */
export function safeToken(value: unknown, pattern: RegExp, fallback: string): string {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}

/** Classifies and allowlists a failure kind against the closed vocabulary. */
export function safeErrorKind(errorText: string | undefined): string {
  const kind = classifyErrorKind(errorText ?? "");
  return KNOWN_ERROR_KINDS.has(kind) && ERROR_KIND_PATTERN.test(kind) ? kind : "UNKNOWN";
}

export type EventKind = "user" | "assistant" | "toolCall" | "toolResult";

/**
 * Normalized session event. Content-bearing fields (contentText, path,
 * editLocator) are in-memory only and never rendered into shared reports.
 */
export interface MiningEvent {
  id: string;
  ts: string;
  kind: EventKind;
  /** Structural (safe) fields. */
  toolName?: string;
  toolCallId?: string;
  argKeys?: string[];
  argTypes?: Record<string, string>;
  isError?: boolean;
  errorKind?: string;
  /** In-memory only; worksheet artifact only. */
  errorText?: string;
  contentText?: string;
  /** In-memory only: linkage detection inputs. */
  path?: string;
  editLocator?: string;
}

export type RecoveryShape =
  | "same-tool-retry"
  | "different-tool-recovery"
  | "user-intervention"
  | "unrelated-continuation"
  | "abandonment"
  | "unresolved";

export interface LinkageSignals {
  samePathLocally: boolean;
  locatorExtension: boolean;
  repeatedToolShape: boolean;
  nextSuccessfulCall: boolean;
  interveningUnrelatedEvents: number;
}

export interface FailedEpisode {
  episodeId: string;
  sessionId: string;
  failedIndex: number;
  family: string;
  shape: RecoveryShape;
  prior: MiningEvent[];
  call: MiningEvent;
  result?: MiningEvent;
  following: MiningEvent[];
  signals: LinkageSignals;
}

export interface MineOptions {
  priorLimit?: number;
  followingLimit?: number;
}

/** Structural family: attempted tool plus classified failure kind (allowlisted). */
export function structuralFamily(toolName: unknown, errorText: string | undefined): string {
  const tool = safeToken(toolName, TOOL_NAME_PATTERN, "unknown");
  return `${tool}/${safeErrorKind(errorText)}`;
}

function isSameTarget(left: MiningEvent | undefined, right: MiningEvent | undefined): boolean {
  return typeof left?.path === "string" && left.path.length > 0 && left.path === right?.path;
}

function locatorExtends(earlier: MiningEvent | undefined, later: MiningEvent | undefined): boolean {
  const earlierLocator = earlier?.editLocator;
  const laterLocator = later?.editLocator;
  return typeof earlierLocator === "string" && typeof laterLocator === "string"
    && laterLocator.includes(earlierLocator)
    && laterLocator.length > earlierLocator.length;
}

function sameToolShape(left: MiningEvent, right: MiningEvent): boolean {
  if (left.toolName !== right.toolName) return false;
  const leftKeys = [...(left.argKeys ?? [])].sort().join(",");
  const rightKeys = [...(right.argKeys ?? [])].sort().join(",");
  return leftKeys === rightKeys;
}

/**
 * Deterministic recovery-shape classification. It describes what happened
 * next; it makes no claim about why.
 */
export function classifyRecoveryShape(episode: Omit<FailedEpisode, "shape" | "signals" | "family">): RecoveryShape {
  if (episode.result === undefined) return "unresolved";

  for (const event of episode.following) {
    if (event.kind === "user") return "user-intervention";
    if (event.kind !== "toolCall") continue;
    if (event.toolName === episode.call.toolName) return "same-tool-retry";
    if (isSameTarget(episode.call, event)) return "different-tool-recovery";
    return "unrelated-continuation";
  }
  return "abandonment";
}

/** Bounded linkage signals; structural observations, not intent claims. */
export function linkageSignals(episode: Omit<FailedEpisode, "shape" | "signals" | "family">): LinkageSignals {
  const firstFollowing = episode.following.find((event) => event.kind === "toolCall");
  const firstFollowingResult = firstFollowing === undefined
    ? undefined
    : episode.following.find((event) => event.kind === "toolResult" && event.toolCallId === firstFollowing.toolCallId);

  const interveningUnrelatedEvents = episode.following
    .slice(0, firstFollowing === undefined ? episode.following.length : episode.following.indexOf(firstFollowing))
    .filter((event) => event.kind === "user")
    .length;

  return {
    samePathLocally: isSameTarget(episode.call, firstFollowing),
    locatorExtension: locatorExtends(episode.call, firstFollowing),
    repeatedToolShape: firstFollowing ? sameToolShape(episode.call, firstFollowing) : false,
    nextSuccessfulCall: firstFollowingResult?.isError === false,
    interveningUnrelatedEvents,
  };
}

/** Deterministically extracts bounded episodes from one session's events. */
export function mineEpisodes(sessionId: string, events: readonly MiningEvent[], options: MineOptions = {}): FailedEpisode[] {
  const priorLimit = options.priorLimit ?? PRIOR_LIMIT;
  const followingLimit = options.followingLimit ?? FOLLOWING_LIMIT;

  const episodes: FailedEpisode[] = [];
  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;
    const resultIndex = typeof call.toolCallId === "string"
      ? events.findIndex((event) => event.kind === "toolResult" && event.toolCallId === call.toolCallId)
      : -1;
    const result = resultIndex === -1 ? undefined : events[resultIndex];
    const failed = result?.isError === true || result === undefined;
    if (!failed) continue;

    const prior = events.slice(Math.max(0, index - priorLimit), index);
    // Following events begin strictly AFTER the matched failure result in
    // original JSONL order. With parallel calls, sibling calls/results that
    // precede the matched result are therefore never classified as following.
    const followingStart = resultIndex === -1 ? index + 1 : resultIndex + 1;
    const following = events.slice(followingStart, followingStart + followingLimit);
    const safeSessionId = safeToken(sessionId, OPAQUE_ID_PATTERN, "unknown-session");
    const window = {
      episodeId: `${safeSessionId}#${safeToken(call.toolCallId ?? call.id, OPAQUE_ID_PATTERN, "unknown-call")}`,
      sessionId: safeSessionId,
      failedIndex: index,
      prior,
      call,
      ...(result === undefined ? {} : { result }),
      following,
    };
    episodes.push({
      ...window,
      family: structuralFamily(call.toolName, result?.errorText),
      shape: classifyRecoveryShape(window),
      signals: linkageSignals(window),
    });
  }
  return episodes;
}
