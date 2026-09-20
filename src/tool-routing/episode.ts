/**
 * TASK-0033 — bounded wrong-tool episodes.
 *
 * Mines a validation/schema failure, matches its argument shape against the
 * closed tool contracts, and looks for a structurally equivalent successful
 * call within three following tool calls. Argument values stay in memory; the
 * episode keeps only keys, types, and the bounded label.
 */

import { candidateMatches, classifyMatch, declaredKeysOf, isValidationFailure, narrowByDeclaredKeys, shapeOf, type ArgShape, type MatchKind, type ToolMatch } from "./match.ts";

export const FOLLOWING_CALL_WINDOW = 3;

export interface RoutingEvent {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  toolCallId?: string;
  /** In-memory only; never written to requests or reports. */
  args?: Record<string, unknown>;
  isError?: boolean;
  errorText?: string;
}

export type LabelKind = "reroute" | "retry";

/**
 * "values" = same keys and equal values (a pure rename/reroute shape);
 * "shape" = same keys and same value types, values may differ (the agent fixed
 * the call too). Shape agreement is the primary structural label.
 */
export type LabelEvidence = "values" | "shape";

export interface RoutingEpisode {
  episodeId: string;
  sessionId: string;
  sourceTool: string;
  shape: ArgShape;
  declaredKeys: string[];
  matches: ToolMatch[];
  kind: MatchKind;
  /** Later successful tool within the window with equivalent arguments. */
  labelTool?: string;
  labelKind?: LabelKind;
  /** How the later success agreed with the failed call. */
  labelEvidence?: LabelEvidence;
  /** True when the same later call also had equal values. */
  strictValueAgreement?: boolean;
}

export interface RoutingAttrition {
  mined: number;
  shapeKnown: number;
  /** Later success with the same key/type shape. */
  equivalentSuccess: number;
  /** Subset of the above with equal values too. */
  valueEquivalentSuccess: number;
  reroute: number;
  retry: number;
  strictReroute: number;
  strictRetry: number;
  noSuccess: number;
  /** `write` invoked with bash's `command`/`timeout` shape. */
  wrongToolCommandShape: number;
  wrongToolCommandShapeCorrect: number;
  /** Any source tool failing with the `command`/`timeout` shape. */
  commandShapeAnySource: number;
  /** Narrows to the observed source tool -> label tool reroute pairs. */
  reroutePairs: Record<string, number>;
}

function resultByCall(events: readonly RoutingEvent[]): Map<string, RoutingEvent> {
  const map = new Map<string, RoutingEvent>();
  for (const event of events) {
    if (event.kind === "toolResult" && typeof event.toolCallId === "string") map.set(event.toolCallId, event);
  }
  return map;
}

function sameArguments(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function sameShape(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const leftShape = shapeOf(left);
  const rightShape = shapeOf(right);
  const leftKeys = Object.keys(leftShape);
  const rightKeys = Object.keys(rightShape);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => leftShape[key] === rightShape[key]);
}

/** First successful call with a structurally equivalent argument map. */
function findEquivalentSuccess(events: readonly RoutingEvent[], failureIndex: number): { event: RoutingEvent; evidence: LabelEvidence } | undefined {
  const results = resultByCall(events);
  const failure = events[failureIndex]!;
  const args = failure.args ?? {};
  let callsSeen = 0;
  for (let index = failureIndex + 1; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") return undefined;
    if (event.kind !== "toolCall") continue;
    callsSeen++;
    if (callsSeen > FOLLOWING_CALL_WINDOW) return undefined;
    const result = typeof event.toolCallId === "string" ? results.get(event.toolCallId) : undefined;
    if (result === undefined || result.isError === true) continue;
    if (sameArguments(args, event.args ?? {})) return { event, evidence: "values" };
    if (sameShape(args, event.args ?? {})) return { event, evidence: "shape" };
  }
  return undefined;
}

export function extractRoutingEpisodes(sessionId: string, events: readonly RoutingEvent[]): { episodes: RoutingEpisode[]; attrition: RoutingAttrition } {
  const results = resultByCall(events);
  const episodes: RoutingEpisode[] = [];
  const attrition: RoutingAttrition = {
    mined: 0,
    shapeKnown: 0,
    equivalentSuccess: 0,
    valueEquivalentSuccess: 0,
    reroute: 0,
    retry: 0,
    strictReroute: 0,
    strictRetry: 0,
    noSuccess: 0,
    wrongToolCommandShape: 0,
    wrongToolCommandShapeCorrect: 0,
    commandShapeAnySource: 0,
    reroutePairs: {},
  };

  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;
    const result = typeof call.toolCallId === "string" ? results.get(call.toolCallId) : undefined;
    if (result?.isError !== true || !isValidationFailure(result.errorText, call.toolName)) continue;
    attrition.mined++;
    if (call.args === undefined || Object.keys(call.args).length === 0) continue;
    attrition.shapeKnown++;

    const shape = shapeOf(call.args);
    const declaredKeys = declaredKeysOf(result.errorText);
    const matches = narrowByDeclaredKeys(candidateMatches(call.toolName, shape), declaredKeys);
    const kind = classifyMatch(matches);
    const success = findEquivalentSuccess(events, index);
    const labelKind: LabelKind | undefined = success === undefined ? undefined : success.event.toolName === call.toolName ? "retry" : "reroute";

    const shapeKeys = Object.keys(shape).sort();
    const commandShape = shapeKeys.length === 2 && shapeKeys[0] === "command" && shapeKeys[1] === "timeout"
      && shape.command === "string" && shape.timeout === "number";
    if (commandShape) attrition.commandShapeAnySource++;
    const wrongToolCommandShape = call.toolName === "write" && commandShape;
    if (wrongToolCommandShape) attrition.wrongToolCommandShape++;

    if (success === undefined) {
      attrition.noSuccess++;
    } else {
      attrition.equivalentSuccess++;
      const strict = success.evidence === "values";
      if (strict) attrition.valueEquivalentSuccess++;
      if (labelKind === "reroute") {
        attrition.reroute++;
        const pair = `${call.toolName}->${success.event.toolName}`;
        attrition.reroutePairs[pair] = (attrition.reroutePairs[pair] ?? 0) + 1;
        if (wrongToolCommandShape && success.event.toolName === "bash") attrition.wrongToolCommandShapeCorrect++;
        if (strict) attrition.strictReroute++;
      } else {
        attrition.retry++;
        if (strict) attrition.strictRetry++;
      }
    }

    episodes.push({
      episodeId: `${sessionId}#${call.toolCallId ?? call.id}`,
      sessionId,
      sourceTool: call.toolName,
      shape,
      declaredKeys,
      matches,
      kind,
      ...(success?.event.toolName === undefined || labelKind === undefined
        ? {}
        : { labelTool: success.event.toolName, labelKind, labelEvidence: success.evidence, strictValueAgreement: success.evidence === "values" }),
    });
  }
  return { episodes, attrition };
}
