/**
 * TASK-0037 — local-only prospective label collector.
 *
 * Observes the verified public lifecycle `tool_execution_start` (raw arguments
 * before validation) and `tool_execution_end` (result + error flag). An episode
 * opens ONLY after an anchored Pi validation failure for the same tool call, so
 * valid calls never open one. Labels come from the next three tool calls that
 * START after confirmation and match a TASK-0036 plan with unchanged values.
 *
 * Never executes, mutates, reroutes, or calls a model. Raw arguments live only
 * in bounded memory and are never persisted; the JSONL record holds safe key
 * tokens, canonical roles, ordinals, and closed counters.
 */

import { planMappings, type MappingPlan } from "../tool-mapping/planner.ts";
import { TOOL_CONTRACTS } from "../tool-routing/contracts.ts";
import { planMatchesCall } from "../tool-mapping/episode.ts";

export const FOLLOWING_CALL_WINDOW = 3;
export const MAX_PENDING_EPISODES = 8;
export const MAX_OBSERVED_CALLS = 32;

const PI_VALIDATION_HEADER = /^\s*Validation failed for tool "([A-Za-z0-9_.-]{1,60})":/;

export interface ToolStart { toolCallId: string; toolName: string; args: unknown }
export interface ToolEnd { toolCallId: string; toolName: string; isError: boolean; errorText?: string }

export interface LabelRecord {
  ts: string;
  sessionId: string;
  episodeId: string;
  sourceTool: string;
  targetTool: string;
  planOrdinal: number;
  /** `role<-from` pairs: keys/roles only, never values. */
  pairs: string[];
  /** Tool calls that started after confirmation before the label. */
  interveningCalls: number;
  latencyMs: number;
}

interface PendingEpisode {
  episodeId: string;
  sourceTool: string;
  args: Record<string, unknown>;
  plans: MappingPlan[];
  /**
   * Sequence number at confirmation time. Every call that started before the
   * failure was confirmed (the failing call and any parallel siblings already
   * in flight) has a lower sequence and can never label this episode.
   */
  confirmedSequence: number;
  openedAt: number;
}

export interface CollectorStats {
  observedCalls: number;
  validationFailures: number;
  episodesOpened: number;
  labelled: number;
  expired: number;
  ineligible: number;
}

export interface ProspectiveLabelCollector {
  onToolStart(event: ToolStart): void;
  onToolEnd(event: ToolEnd, now?: number): void;
  onToolSuccess(toolName: string, args: unknown, now: number): LabelRecord | undefined;
  pendingCount(): number;
  stats(): CollectorStats;
  clear(): void;
}

export function createProspectiveLabelCollector(options: {
  isEnabled: () => boolean;
  sessionId: () => string;
  onLabel?: (record: LabelRecord) => void;
  maxPending?: number;
}): ProspectiveLabelCollector {
  const maxPending = options.maxPending ?? MAX_PENDING_EPISODES;
  const pending = new Map<string, PendingEpisode>();
  const starts = new Map<string, { toolName: string; args: unknown; sequence: number }>();
  const confirmedOrder: string[] = [];
  const stats: CollectorStats = { observedCalls: 0, validationFailures: 0, episodesOpened: 0, labelled: 0, expired: 0, ineligible: 0 };
  let sequence = 0;

  const forget = (toolCallId: string): void => {
    pending.delete(toolCallId);
    const index = confirmedOrder.indexOf(toolCallId);
    if (index >= 0) confirmedOrder.splice(index, 1);
  };

  return {
    onToolStart(event) {
      if (!options.isEnabled()) return;
      sequence++;
      stats.observedCalls++;
      starts.set(event.toolCallId, { toolName: event.toolName, args: event.args, sequence });
      // Bounded memory: oldest unlabelled episodes expire first.
      while (pending.size > maxPending) {
        const oldest = pending.keys().next();
        if (oldest.done === true) break;
        forget(oldest.value);
        stats.expired++;
      }
      // Expire episodes whose window closed before this call.
      for (const [id, episode] of [...pending]) {
        const started = starts.get(id);
        if (started === undefined) continue;
        if (sequence - episode.confirmedSequence > FOLLOWING_CALL_WINDOW) {
          forget(id);
          stats.expired++;
        }
      }
    },

    onToolEnd(event, now = Date.now()) {
      if (!options.isEnabled()) return;
      const started = starts.get(event.toolCallId);
      // Confirmation: an anchored Pi validation failure for this exact tool call.
      const headerTool = PI_VALIDATION_HEADER.exec(event.errorText ?? "")?.[1];
      if (event.isError !== true || headerTool === undefined || headerTool !== event.toolName) return;
      stats.validationFailures++;
      if (started === undefined || started.args === null || typeof started.args !== "object" || Array.isArray(started.args)) {
        stats.ineligible++;
        return;
      }
      const enumeration = planMappings(event.toolName, started.args);
      if (enumeration.status !== "plans") {
        stats.ineligible++;
        return;
      }
      pending.set(event.toolCallId, {
        episodeId: `${options.sessionId()}#${event.toolCallId}`,
        sourceTool: event.toolName,
        args: started.args as Record<string, unknown>,
        plans: enumeration.plans,
        confirmedSequence: sequence,
        openedAt: now,
      });
      confirmedOrder.push(event.toolCallId);
      stats.episodesOpened++;
    },

    onToolSuccess(toolName, args, now) {
      if (!options.isEnabled() || pending.size === 0) return undefined;
      const current = sequence;
      for (const id of [...confirmedOrder]) {
        const episode = pending.get(id);
        if (episode === undefined) continue;
        // Earlier parallel siblings are excluded: only calls that start after
        // confirmation can label the episode.
        const started = starts.get(id);
        if (started !== undefined && current <= episode.confirmedSequence) continue;
        if (current - episode.confirmedSequence > FOLLOWING_CALL_WINDOW) {
          forget(id);
          stats.expired++;
          continue;
        }
        const matching = episode.plans.find((plan) => planMatchesCall(plan, { id, ts: "", kind: "toolCall", toolName, args: args as Record<string, unknown> }));
        if (matching === undefined) continue;
        const record: LabelRecord = {
          ts: new Date(now).toISOString(),
          sessionId: options.sessionId(),
          episodeId: episode.episodeId,
          sourceTool: episode.sourceTool,
          targetTool: matching.targetTool,
          planOrdinal: matching.ordinal,
          pairs: matching.pairs.map((pair) => `${pair.to}<-${pair.from}`),
          interveningCalls: Math.max(0, current - episode.confirmedSequence - 1),
          latencyMs: Math.max(0, now - episode.openedAt),
        };
        forget(id);
        stats.labelled++;
        options.onLabel?.(record);
        return record;
      }
      return undefined;
    },

    pendingCount: () => pending.size,
    stats: () => ({ ...stats }),
    clear() {
      pending.clear();
      confirmedOrder.length = 0;
      starts.clear();
      sequence = 0;
    },
  };
}

/** Privacy-safe JSONL rendering: keys, roles, ordinals, counters only. */
export function renderLabelRecord(record: LabelRecord): string {
  return JSON.stringify({
    ts: record.ts,
    eventType: "prospective-label",
    sessionId: record.sessionId,
    episodeId: record.episodeId,
    sourceTool: record.sourceTool,
    targetTool: record.targetTool,
    planOrdinal: record.planOrdinal,
    pairs: record.pairs,
    interveningCalls: record.interveningCalls,
    latencyMs: record.latencyMs,
  });
}

/** Guard used by tests and the writer: no value text can appear in a record. */
export function labelRecordIsPrivacySafe(record: LabelRecord): boolean {
  const serialized = renderLabelRecord(record);
  const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;
  if (!identifier.test(record.sourceTool)) return false;
  if (!identifier.test(record.targetTool)) return false;
  if (record.pairs.some((pair) => !pair.split("<-").every((token) => identifier.test(token)))) return false;
  return !serialized.includes("\n") && TOOL_CONTRACTS.has(record.targetTool);
}
