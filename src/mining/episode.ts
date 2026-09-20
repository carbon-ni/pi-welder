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

/** Structural family: attempted tool plus classified failure kind. */
export function structuralFamily(toolName: string, errorText: string | undefined): string {
  return `${toolName}/${classifyErrorKind(errorText ?? "")}`;
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
  const resultByCall = new Map<string, MiningEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") resultByCall.set(event.toolCallId, event);
  }

  const episodes: FailedEpisode[] = [];
  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;
    const result = typeof call.toolCallId === "string" ? resultByCall.get(call.toolCallId) : undefined;
    const failed = result?.isError === true || result === undefined;
    if (!failed) continue;

    const prior = events.slice(Math.max(0, index - priorLimit), index);
    // The matched failure result is part of the failure pair, never a following event.
    const following = events
      .slice(index + 1)
      .filter((event) => event.id !== result?.id)
      .slice(0, followingLimit);
    const window = { episodeId: `${sessionId}#${call.toolCallId ?? call.id}`, sessionId, failedIndex: index, prior, call, ...(result === undefined ? {} : { result }), following };
    episodes.push({
      ...window,
      family: structuralFamily(call.toolName, result?.errorText),
      shape: classifyRecoveryShape(window),
      signals: linkageSignals(window),
    });
  }
  return episodes;
}
