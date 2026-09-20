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
import { buildToolMappingRequest } from "../tool-mapping/evaluation.ts";
import { TOOL_CONTRACTS } from "../tool-routing/contracts.ts";
import { planMatchesCall } from "../tool-mapping/episode.ts";

export const FOLLOWING_CALL_WINDOW = 3;
export const MAX_PENDING_EPISODES = 8;
/** Bounded raw-argument retention. Eviction is fail-closed and accounted. */
export const MAX_OBSERVED_CALLS = 32;
export const MAX_RAW_ARG_BYTES = 8_192;
export const MAX_TOTAL_RAW_BYTES = 65_536;

const PI_VALIDATION_HEADER = /^\s*Validation failed for tool "([A-Za-z0-9_.-]{1,60})":/;

export interface ToolStart { toolCallId: string; toolName: string; args: unknown }
export interface ToolEnd { toolCallId: string; toolName: string; isError: boolean; errorText?: string; args?: unknown }

export type LabelOutcome = "labelled" | "expired" | "interrupted";

export interface LabelRecord {
  ts: string;
  sessionId: string;
  episodeId: string;
  outcome: LabelOutcome;
  sourceTool: string;
  /** Present only for a confirmed success. */
  targetTool?: string;
  planOrdinal?: number;
  /** `role<-from` pairs: keys/roles only, never values. */
  pairs: string[];
  /** Closed judge-input snapshot so the future request can be replayed. */
  request: unknown;
  /** Tool calls that started after confirmation before the outcome. */
  interveningCalls: number;
  latencyMs: number;
}

interface PendingEpisode {
  episodeId: string;
  sourceTool: string;
  request: unknown;
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
  interrupted: number;
  ineligible: number;
  evictedStarts: number;
  oversizedStarts: number;
  retainedRawBytes: number;
}

export interface ProspectiveLabelCollector {
  onToolStart(event: ToolStart): void;
  /** Finalizes on the correlated end: success labels, failure consumes the window. */
  onToolEnd(event: ToolEnd, now?: number): LabelRecord[];
  /** Closes every unresolved episode as persisted evidence (turn end/interruption). */
  closeUnresolved(reason: "expired" | "interrupted", now?: number): LabelRecord[];
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
  const starts = new Map<string, { toolName: string; args: unknown; sequence: number; bytes: number }>();
  let retainedBytes = 0;
  const confirmedOrder: string[] = [];
  const stats: CollectorStats = { observedCalls: 0, validationFailures: 0, episodesOpened: 0, labelled: 0, expired: 0, interrupted: 0, ineligible: 0, evictedStarts: 0, oversizedStarts: 0, retainedRawBytes: 0 };
  let sequence = 0;

  const forget = (toolCallId: string): void => {
    pending.delete(toolCallId);
    const index = confirmedOrder.indexOf(toolCallId);
    if (index >= 0) confirmedOrder.splice(index, 1);
  };

  const dropStart = (toolCallId: string): void => {
    const entry = starts.get(toolCallId);
    if (entry === undefined) return;
    retainedBytes -= entry.bytes;
    starts.delete(toolCallId);
  };

  return {
    onToolStart(event) {
      if (!options.isEnabled()) return;
      sequence++;
      stats.observedCalls++;

      // Per-entry cap: an oversized payload is never retained (fail closed).
      const bytes = Buffer.byteLength(JSON.stringify(event.args ?? null), "utf8");
      if (bytes > MAX_RAW_ARG_BYTES) {
        stats.oversizedStarts++;
        dropStart(event.toolCallId);
        stats.retainedRawBytes = retainedBytes;
        return;
      }
      dropStart(event.toolCallId);
      starts.set(event.toolCallId, { toolName: event.toolName, args: event.args, sequence, bytes });
      retainedBytes += bytes;

      // Bounded count and aggregate bytes: evict oldest, always fail closed.
      while (starts.size > MAX_OBSERVED_CALLS || retainedBytes > MAX_TOTAL_RAW_BYTES) {
        const oldest = starts.keys().next();
        if (oldest.done === true) break;
        dropStart(oldest.value);
        stats.evictedStarts++;
      }
      stats.retainedRawBytes = retainedBytes;

      // Bound pending episodes and expire windows that closed before this call.
      while (pending.size > maxPending) {
        const oldest = pending.keys().next();
        if (oldest.done === true) break;
        forget(oldest.value);
        stats.expired++;
      }
      for (const [id, episode] of [...pending]) {
        if (sequence - episode.confirmedSequence > FOLLOWING_CALL_WINDOW) {
          forget(id);
          stats.expired++;
        }
      }
    },

    onToolEnd(event, now = Date.now()) {
      if (!options.isEnabled()) return [];
      const started = starts.get(event.toolCallId);
      dropStart(event.toolCallId);
      stats.retainedRawBytes = retainedBytes;
      if (started === undefined) return [];

      const headerTool = PI_VALIDATION_HEADER.exec(event.errorText ?? "")?.[1];
      const isValidationFailure = event.isError === true && headerTool !== undefined && headerTool === event.toolName;

      if (isValidationFailure) {
        stats.validationFailures++;
        if (started.args === null || typeof started.args !== "object" || Array.isArray(started.args)) {
          stats.ineligible++;
          return [];
        }
        const enumeration = planMappings(event.toolName, started.args);
        if (enumeration.status !== "plans") {
          stats.ineligible++;
          return [];
        }
        pending.set(event.toolCallId, {
          episodeId: `${options.sessionId()}#${event.toolCallId}`,
          sourceTool: event.toolName,
          request: buildToolMappingRequest(event.toolName, enumeration.plans, started.args as Record<string, unknown>).state,
          plans: enumeration.plans,
          confirmedSequence: sequence,
          openedAt: now,
        });
        confirmedOrder.push(event.toolCallId);
        stats.episodesOpened++;
        return [];
      }

      // A failed, timed-out, aborted, or blocked call consumes the window but
      // can never label an episode.
      if (event.isError === true) return [];

      // Confirmed success: this is the only place a label can be produced.
      // The end event carries no arguments, so the start payload is the source.
      const emitted: LabelRecord[] = [];
      for (const id of [...confirmedOrder]) {
        const episode = pending.get(id);
        if (episode === undefined) continue;
        const current = sequence;
        if (current <= episode.confirmedSequence) continue; // parallel sibling started before confirmation
        if (current - episode.confirmedSequence > FOLLOWING_CALL_WINDOW) {
          forget(id);
          stats.expired++;
          continue;
        }
        if (started.toolName !== event.toolName) continue;
        if (started.args === null || typeof started.args !== "object" || Array.isArray(started.args)) continue;
        const successArgs = started.args as Record<string, unknown>;
        const matching = episode.plans.find((plan) => planMatchesCall(plan, { id, ts: "", kind: "toolCall", toolName: event.toolName, args: successArgs }));
        if (matching === undefined) continue;
        const record: LabelRecord = {
          ts: new Date(now).toISOString(),
          sessionId: options.sessionId(),
          episodeId: episode.episodeId,
          outcome: "labelled",
          sourceTool: episode.sourceTool,
          targetTool: matching.targetTool,
          planOrdinal: matching.ordinal,
          pairs: matching.pairs.map((pair) => `${pair.to}<-${pair.from}`),
          request: episode.request,
          interveningCalls: Math.max(0, current - episode.confirmedSequence - 1),
          latencyMs: Math.max(0, now - episode.openedAt),
        };
        forget(id);
        stats.labelled++;
        options.onLabel?.(record);
        emitted.push(record);
      }
      return emitted;
    },

    closeUnresolved(reason, now = Date.now()) {
      if (!options.isEnabled()) return [];
      const emitted: LabelRecord[] = [];
      for (const id of [...confirmedOrder]) {
        const episode = pending.get(id);
        forget(id);
        if (episode === undefined) continue;
        if (reason === "expired") stats.expired++;
        else stats.interrupted++;
        const record: LabelRecord = {
          ts: new Date(now).toISOString(),
          sessionId: options.sessionId(),
          episodeId: episode.episodeId,
          outcome: reason,
          sourceTool: episode.sourceTool,
          pairs: [],
          request: episode.request,
          interveningCalls: Math.max(0, sequence - episode.confirmedSequence),
          latencyMs: Math.max(0, now - episode.openedAt),
        };
        options.onLabel?.(record);
        emitted.push(record);
      }
      return emitted;
    },

    pendingCount: () => pending.size,
    stats: () => ({ ...stats }),
    clear() {
      pending.clear();
      confirmedOrder.length = 0;
      starts.clear();
      retainedBytes = 0;
      stats.retainedRawBytes = 0;
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
    outcome: record.outcome,
    sourceTool: record.sourceTool,
    ...(record.targetTool === undefined ? {} : { targetTool: record.targetTool }),
    ...(record.planOrdinal === undefined ? {} : { planOrdinal: record.planOrdinal }),
    pairs: record.pairs,
    request: record.request,
    interveningCalls: record.interveningCalls,
    latencyMs: record.latencyMs,
  });
}

/** Guard used by tests and the writer: no value text can appear in a record. */
export function labelRecordIsPrivacySafe(record: LabelRecord): boolean {
  const serialized = renderLabelRecord(record);
  const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;
  if (!identifier.test(record.sourceTool)) return false;
  if (record.targetTool !== undefined && !identifier.test(record.targetTool)) return false;
  if (record.pairs.some((pair) => !pair.split("<-").every((token) => identifier.test(token)))) return false;
  if (serialized.includes("\n")) return false;
  // Unresolved outcomes carry no target, so they are valid without one.
  return record.targetTool === undefined || TOOL_CONTRACTS.has(record.targetTool);
}
