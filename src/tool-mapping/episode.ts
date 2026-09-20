/**
 * TASK-0036 — historical plan-mapping episodes.
 *
 * Mines strict Pi validation failures, plans bounded `{target tool, mapping}`
 * hypotheses, and labels the episode from a bounded later successful call that
 * matches a plan exactly: same target tool and every mapped value unchanged.
 * Values stay in memory; only keys, roles, features, and ordinals leave.
 */

import { planMappings, satisfiesConstraint, valueKindOf, type MappingPlan, type PlanEnumeration, type PlannerOptions } from "./planner.ts";
import { TOOL_CONTRACTS } from "../tool-routing/contracts.ts";

export const FOLLOWING_CALL_WINDOW = 3;

export interface MappingEvent {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  toolCallId?: string;
  /** In-memory only. */
  args?: Record<string, unknown>;
  isError?: boolean;
  errorText?: string;
}

export interface PlanEpisode {
  episodeId: string;
  sessionId: string;
  sourceTool: string;
  plans: MappingPlan[];
  /** Hidden ground truth: first plan ordinal the later call matched exactly. */
  labelPlanOrdinal?: number;
  targetTool?: string;
}

export interface PlanAttrition {
  mined: number;
  planned: number;
  abstained: number;
  labelled: number;
  noLaterCall: number;
  abstainReasons: Record<string, number>;
}

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
 * A later call matches a plan when the tool agrees, every mapped value is
 * unchanged, and any extra field is valid for the target schema.
 *
 * Optional extras are accepted on purpose: a correction legitimately adds
 * optional fields the malformed call did not carry (a `bash` call may gain a
 * `timeout`). An extra field that the target schema does not define, or whose
 * type/constraint fails, is rejected, so the label can never come from a call
 * that is not a valid instance of the planned tool.
 */
export function planMatchesCall(plan: MappingPlan, event: MappingEvent): boolean {
  if (event.toolName !== plan.targetTool) return false;
  const args = event.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const contract = TOOL_CONTRACTS.get(plan.targetTool);
  if (contract === undefined) return false;

  for (const pair of plan.pairs) {
    if (!Object.is(args[pair.to], plan.args[pair.to])) return false;
  }
  const mapped = new Set(plan.pairs.map((pair) => pair.to));
  for (const key of Object.keys(args)) {
    if (mapped.has(key)) continue;
    const expected = contract.types[key];
    if (expected === undefined) return false;
    if (valueKindOf(args[key]) !== expected) return false;
    if (!satisfiesConstraint(plan.targetTool, key, args[key])) return false;
  }
  // Required target fields must be satisfied by the call itself.
  return contract.required.every((field) => field in args);
}

function findMatchingPlan(events: readonly MappingEvent[], failureIndex: number, plans: readonly MappingPlan[]): MappingPlan | undefined {
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
    const matched = plans.find((plan) => planMatchesCall(plan, event));
    if (matched) return matched;
  }
  return undefined;
}

export function extractPlanEpisodes(
  sessionId: string,
  events: readonly MappingEvent[],
  options: PlannerOptions = {},
  plan: (sourceTool: string, input: unknown) => PlanEnumeration = (sourceTool, input) => planMappings(sourceTool, input, options),
): { episodes: PlanEpisode[]; attrition: PlanAttrition } {
  const results = resultsByCall(events);
  const episodes: PlanEpisode[] = [];
  const attrition: PlanAttrition = { mined: 0, planned: 0, abstained: 0, labelled: 0, noLaterCall: 0, abstainReasons: {} };

  for (let index = 0; index < events.length; index++) {
    const call = events[index]!;
    if (call.kind !== "toolCall" || typeof call.toolName !== "string") continue;
    const result = typeof call.toolCallId === "string" ? results.get(call.toolCallId) : undefined;
    if (result?.isError !== true) continue;
    if (piValidationTool(result.errorText) !== call.toolName) continue;
    if (call.args === undefined) continue;

    attrition.mined++;
    const enumeration = plan(call.toolName, call.args);
    if (enumeration.status !== "plans") {
      attrition.abstained++;
      const reason = enumeration.reason ?? "unknown";
      attrition.abstainReasons[reason] = (attrition.abstainReasons[reason] ?? 0) + 1;
      continue;
    }
    attrition.planned++;

    const matched = findMatchingPlan(events, index, enumeration.plans);
    if (matched === undefined) attrition.noLaterCall++;
    else attrition.labelled++;

    episodes.push({
      episodeId: `${sessionId}#${call.toolCallId ?? call.id}`,
      sessionId,
      sourceTool: call.toolName,
      plans: enumeration.plans,
      ...(matched === undefined ? {} : { labelPlanOrdinal: matched.ordinal, targetTool: matched.targetTool }),
    });
  }
  return { episodes, attrition };
}
