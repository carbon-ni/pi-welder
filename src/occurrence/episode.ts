/**
 * TASK-0032 — non-unique edit occurrence episodes.
 *
 * Mines an `edit` failure reporting 2–5 occurrences, with a later successful
 * same-path edit within three calls, and reconstructs the source snapshot from
 * a following read of the same path that has no user event or mutation before
 * it. The following read reconstructs environment only — it is never an intent
 * signal. The later successful edit is used only to label the intended
 * occurrence.
 */

import { occurrenceOffsets, type PositionBucket } from "./source.ts";

export interface OccurrenceEvent {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  toolCallId?: string;
  path?: string;
  /** Failed edit anchor / later success anchor / read input range. */
  oldText?: string;
  newText?: string;
  offset?: number;
  limit?: number;
  isError?: boolean;
  errorText?: string;
  /** Read result content; in-memory only. */
  content?: string;
}

export const FOLLOWING_CALL_WINDOW = 3;
export const RECONSTRUCTION_READ_WINDOW = 3;

export interface OccurrenceEpisode {
  episodeId: string;
  sessionId: string;
  anchor: string;
  replacement: string;
  occurrences: number;
  source: string;
  /** Hidden label: ordinal of the occurrence the later success targeted. */
  labelOrdinal?: number;
  /** Prior read range of the SAME target (structural) for the nearest-read baseline. */
  priorReadOffset?: number;
  priorReadLimit?: number;
}

function resultByCall(events: readonly OccurrenceEvent[]): Map<string, OccurrenceEvent> {
  const map = new Map<string, OccurrenceEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") map.set(event.toolCallId, event);
  }
  return map;
}

export function occurrenceCount(errorText: string | undefined): number | undefined {
  const match = /found (\d+) occurrences/i.exec(errorText ?? "");
  if (!match) return undefined;
  const count = Number(match[1]);
  return count >= 2 && count <= 5 ? count : undefined;
}

/** Reconstructs the failure-time source from a following same-path read. */
function reconstructSource(events: readonly OccurrenceEvent[], failureIndex: number, path: string): string | undefined {
  const results = resultByCall(events);
  let callsSeen = 0;
  for (let index = failureIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") return undefined; // user intervention invalidates reconstruction
    if (event.kind === "toolCall") {
      callsSeen++;
      if (callsSeen > RECONSTRUCTION_READ_WINDOW) return undefined;
      const result = typeof event.toolCallId === "string" ? results.get(event.toolCallId) : undefined;
      if (result === undefined || result.isError === true) {
        if (event.toolName === "edit" || event.toolName === "write") return undefined; // mutation before a valid read
        continue;
      }
      if (event.toolName === "edit" || event.toolName === "write") return undefined; // mutation invalidates the snapshot
      if (event.toolName === "read" && event.path === path && typeof result.content === "string" && result.content.length > 0) {
        return result.content;
      }
    }
  }
  return undefined;
}

/**
 * Finds the successful same-path edit within the bounded call window
 * (max three following tool calls). Any user event, mutation (`write`), or
 * edit of a different target stops the search. A failed same-path edit still
 * consumes a call from the budget.
 */
function findSuccess(events: readonly OccurrenceEvent[], failureIndex: number, path: string): OccurrenceEvent | undefined {
  const results = resultByCall(events);
  let callsSeen = 0;
  for (let index = failureIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") return undefined;
    if (event.kind !== "toolCall") continue;
    callsSeen++;
    if (callsSeen > FOLLOWING_CALL_WINDOW) return undefined;
    const result = typeof event.toolCallId === "string" ? results.get(event.toolCallId) : undefined;
    if (event.toolName === "write") return undefined;
    if (event.toolName !== "edit") continue;
    if (event.path !== path) return undefined;
    if (result === undefined || result.isError === true) continue;
    if (typeof event.oldText === "string" && event.oldText.length > 0) return event;
    return undefined;
  }
  return undefined;
}

/** Label: ordinal of the failed anchor occurrence contained in the success span. */
export function labelOccurrence(source: string, anchor: string, successfulOldText: string): number | undefined {
  const successMatches = occurrenceOffsets(source, successfulOldText);
  if (successMatches.length !== 1) return undefined;
  const start = successMatches[0]!;
  const end = start + successfulOldText.length;
  const inside = occurrenceOffsets(source, anchor)
    .map((offset, index) => ({ offset, ordinal: index + 1 }))
    .filter((entry) => entry.offset >= start && entry.offset + anchor.length <= end);
  return inside.length === 1 ? inside[0]!.ordinal : undefined;
}

export interface OccurrenceAttrition {
  mined: number;
  occurrencesEligible: number;
  sourceReconstructed: number;
  candidatesBuilt: number;
  /** Later successful anchor extends the failed anchor (context-extension signal). */
  locatorExtensions: number;
  labelable: number;
}

export function extractOccurrenceEpisodes(sessionId: string, events: readonly OccurrenceEvent[]): { episodes: OccurrenceEpisode[]; attrition: OccurrenceAttrition } {
  const results = resultByCall(events);
  const episodes: OccurrenceEpisode[] = [];
  const attrition: OccurrenceAttrition = { mined: 0, occurrencesEligible: 0, sourceReconstructed: 0, candidatesBuilt: 0, locatorExtensions: 0, labelable: 0 };
  let priorReadOffset: number | undefined;
  let priorReadLimit: number | undefined;
  let priorReadPath: string | undefined;

  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall") continue;
    const result = typeof call.toolCallId === "string" ? results.get(call.toolCallId) : undefined;

    if (call.toolName === "read" && result?.isError === false) {
      priorReadOffset = typeof call.offset === "number" ? call.offset : undefined;
      priorReadLimit = typeof call.limit === "number" ? call.limit : undefined;
      priorReadPath = call.path;
      continue;
    }
    if (call.toolName !== "edit" || result?.isError !== true) continue;
    if (typeof call.oldText !== "string" || call.oldText.length === 0 || typeof call.path !== "string") continue;

    const count = occurrenceCount(result.errorText);
    if (count === undefined) continue;
    attrition.mined++;
    attrition.occurrencesEligible++;

    const source = reconstructSource(events, index, call.path);
    if (source === undefined) continue;
    attrition.sourceReconstructed++;
    const occurrences = occurrenceOffsets(source, call.oldText);
    if (occurrences.length < 2 || occurrences.length > 5) continue;
    attrition.candidatesBuilt++;

    const success = findSuccess(events, index, call.path);
    if (success?.oldText !== undefined && success.oldText.includes(call.oldText)) attrition.locatorExtensions++;
    const labelOrdinal = success?.oldText === undefined ? undefined : labelOccurrence(source, call.oldText, success.oldText);
    if (labelOrdinal === undefined) continue;
    attrition.labelable++;

    // The recent-read relation is only meaningful for a read of the same target.
    const readMatchesTarget = priorReadPath === call.path && priorReadOffset !== undefined;
    episodes.push({
      episodeId: `${sessionId}#${call.toolCallId ?? call.id}`,
      sessionId,
      anchor: call.oldText,
      replacement: call.newText ?? "",
      occurrences: occurrences.length,
      source,
      labelOrdinal,
      ...(readMatchesTarget ? { priorReadOffset, ...(priorReadLimit === undefined ? {} : { priorReadLimit }) } : {}),
    });
  }
  return { episodes, attrition };
}

/** Position bucket for an occurrence ordinal. */
export function positionBucketFor(ordinal: number, total: number): PositionBucket {
  if (ordinal === 1) return "first";
  if (ordinal === total) return "last";
  return "middle";
}
