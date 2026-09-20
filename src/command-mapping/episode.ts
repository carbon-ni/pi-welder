/**
 * TASK-0035 — historical non-exact command-mapping episodes.
 *
 * Mines strict Pi validation failures on read/write/edit whose argument shape
 * the exact router would NOT have accepted, and labels the episode from a
 * bounded later successful call that carries one candidate value verbatim as
 * its command. Values stay in memory; only keys, features, and ordinals leave.
 */

import { enumerateCommandMapping, type CommandCandidate, type MappingEnumeration } from "./candidates.ts";

export const FOLLOWING_CALL_WINDOW = 3;

export interface MappingEvent {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  toolCallId?: string;
  /** In-memory only. Never transmitted or logged. */
  args?: Record<string, unknown>;
  isError?: boolean;
  errorText?: string;
}

export interface MappingEpisode {
  episodeId: string;
  sessionId: string;
  sourceTool: string;
  candidates: CommandCandidate[];
  canonicalTimeout: boolean;
  /** Hidden label: ordinal of the candidate the later corrected call used. */
  labelOrdinal?: number;
}

export interface MappingAttrition {
  mined: number;
  enumerated: number;
  abstained: number;
  labelled: number;
  noLaterCall: number;
  /** Why enumeration abstained, by closed reason code. */
  abstainReasons: Record<string, number>;
}

/** Pi's anchored tool-arg validation header, e.g. `Validation failed for tool "edit":`. */
const PI_VALIDATION_HEADER = /^\s*Validation failed for tool "([A-Za-z0-9_.-]{1,60})":/;

export function piValidationTool(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  return PI_VALIDATION_HEADER.exec(errorText)?.[1];
}

function resultsByCall(events: readonly MappingEvent[]): Map<string, MappingEvent> {
  const map = new Map<string, MappingEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") map.set(event.toolCallId, event);
  }
  return map;
}

/**
 * Hidden label: the first successful later tool call (within three calls) that
 * carries one candidate value verbatim in its `command` field. This is the only
 * signal that says which field the agent meant, and it never enters a request.
 */
function findCorrectedOrdinal(events: readonly MappingEvent[], failureIndex: number, candidates: readonly CommandCandidate[]): number | undefined {
  const results = resultsByCall(events);
  let callsSeen = 0;
  for (let index = failureIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") return undefined;
    if (event.kind !== "toolCall") continue;
    callsSeen++;
    if (callsSeen > FOLLOWING_CALL_WINDOW) return undefined;
    const result = typeof event.toolCallId === "string" ? results.get(event.toolCallId) : undefined;
    if (result === undefined || result.isError === true) continue;
    const command = event.args?.command;
    if (typeof command !== "string") continue;
    const matched = candidates.find((candidate) => candidate.value === command);
    if (matched) return matched.ordinal;
  }
  return undefined;
}

export function extractMappingEpisodes(
  sessionId: string,
  events: readonly MappingEvent[],
  enumerate: (toolName: string, input: unknown) => MappingEnumeration = enumerateCommandMapping,
): { episodes: MappingEpisode[]; attrition: MappingAttrition } {
  const results = resultsByCall(events);
  const episodes: MappingEpisode[] = [];
  const attrition: MappingAttrition = { mined: 0, enumerated: 0, abstained: 0, labelled: 0, noLaterCall: 0, abstainReasons: {} };

  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;
    const result = typeof call.toolCallId === "string" ? results.get(call.toolCallId) : undefined;
    if (result?.isError !== true) continue;
    const headerTool = piValidationTool(result.errorText);
    if (headerTool === undefined || headerTool !== call.toolName) continue;
    if (call.args === undefined) continue;

    attrition.mined++;
    const enumeration = enumerate(call.toolName, call.args);
    if (enumeration.status === "abstain") {
      attrition.abstained++;
      const reason = enumeration.reason ?? "unknown";
      attrition.abstainReasons[reason] = (attrition.abstainReasons[reason] ?? 0) + 1;
      continue;
    }
    attrition.enumerated++;

    const labelOrdinal = findCorrectedOrdinal(events, index, enumeration.candidates);
    if (labelOrdinal === undefined) attrition.noLaterCall++;
    else attrition.labelled++;

    episodes.push({
      episodeId: `${sessionId}#${call.toolCallId ?? call.id}`,
      sessionId,
      sourceTool: call.toolName,
      candidates: enumeration.candidates,
      canonicalTimeout: enumeration.canonicalTimeout,
      ...(labelOrdinal === undefined ? {} : { labelOrdinal }),
    });
  }
  return { episodes, attrition };
}
