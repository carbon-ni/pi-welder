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

import { planMappings, MAX_PLANS, type MappingPlan } from "../tool-mapping/planner.ts";
import { buildToolMappingRequest } from "../tool-mapping/evaluation.ts";
import type { MappingPair } from "../tool-mapping/planner.ts";
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

interface PlanMeta { ordinal: number; targetTool: string; pairs: MappingPair[] }

interface PendingEpisode {
  episodeId: string;
  sourceTool: string;
  request: unknown;
  /** At most one bounded original-argument snapshot; never a plan copy. */
  args: Record<string, unknown>;
  argsBytes: number;
  /** Mapping metadata only: no values. */
  plans: PlanMeta[];
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
  /** Returns any episodes expired by this start so the caller can persist them. */
  onToolStart(event: ToolStart, now?: number): LabelRecord[];
  /** Finalizes on the correlated end: success labels, failure consumes the window. */
  onToolEnd(event: ToolEnd, now?: number): LabelRecord[];
  /** Closes every unresolved episode as persisted evidence (turn end/interruption). */
  closeUnresolved(reason: "expired" | "interrupted", now?: number): LabelRecord[];
  pendingCount(): number;
  stats(): CollectorStats;
  clear(): void;
}

/** Rebuilds a plan from metadata + the bounded snapshot; undefined if incomplete. */
function derivePlan(meta: PlanMeta, snapshot: Record<string, unknown>): MappingPlan | undefined {
  const args: Record<string, unknown> = {};
  for (const pair of meta.pairs) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, pair.from)) return undefined;
    args[pair.to] = snapshot[pair.from];
  }
  return { ordinal: meta.ordinal, targetTool: meta.targetTool, pairs: meta.pairs, args };
}

export function createProspectiveLabelCollector(options: {
  isEnabled: () => boolean;
  sessionId: () => string;
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
    const episode = pending.get(toolCallId);
    if (episode !== undefined) retainedBytes -= episode.argsBytes;
    pending.delete(toolCallId);
    stats.retainedRawBytes = retainedBytes;
    const index = confirmedOrder.indexOf(toolCallId);
    if (index >= 0) confirmedOrder.splice(index, 1);
  };

  const closureRecord = (episode: PendingEpisode, outcome: LabelOutcome, now: number): LabelRecord => ({
    ts: new Date(now).toISOString(),
    sessionId: options.sessionId(),
    episodeId: episode.episodeId,
    outcome,
    sourceTool: episode.sourceTool,
    pairs: [],
    request: episode.request,
    interveningCalls: Math.max(0, sequence - episode.confirmedSequence),
    latencyMs: Math.max(0, now - episode.openedAt),
  });

  const dropStart = (toolCallId: string): void => {
    const entry = starts.get(toolCallId);
    if (entry === undefined) return;
    retainedBytes -= entry.bytes;
    starts.delete(toolCallId);
  };

  return {
    onToolStart(event, now = Date.now()) {
      if (!options.isEnabled()) return [];
      sequence++;
      stats.observedCalls++;

      // Per-entry cap: an oversized payload is never retained (fail closed).
      const bytes = Buffer.byteLength(JSON.stringify(event.args ?? null), "utf8");
      if (bytes > MAX_RAW_ARG_BYTES) {
        stats.oversizedStarts++;
        dropStart(event.toolCallId);
        stats.retainedRawBytes = retainedBytes;
        return [];
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

      // Expire windows that closed before this call, oldest first, and return
      // their outcomes so the caller persists them (never silently dropped).
      const expired: LabelRecord[] = [];
      for (const [id, episode] of [...pending]) {
        if (sequence - episode.confirmedSequence > FOLLOWING_CALL_WINDOW) {
          const record = closureRecord(episode, "expired", now);
          forget(id);
          stats.expired++;
          expired.push(record);
        }
      }
      return expired;
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
        const argsBytes = Buffer.byteLength(JSON.stringify(started.args), "utf8");
        if (retainedBytes + argsBytes > MAX_TOTAL_RAW_BYTES) {
          dropStart(event.toolCallId);
          stats.evictedStarts++;
          stats.retainedRawBytes = retainedBytes;
          return [];
        }
        retainedBytes += argsBytes;
        stats.retainedRawBytes = retainedBytes;
        // Bound immediately before opening: evict the oldest deterministically
        // and return its outcome so the caller persists it.
        const evicted: LabelRecord[] = [];
        while (pending.size >= maxPending) {
          const oldest = confirmedOrder[0];
          if (oldest === undefined) break;
          const stale = pending.get(oldest);
          if (stale === undefined) { forget(oldest); continue; }
          evicted.push(closureRecord(stale, "expired", now));
          forget(oldest);
          stats.expired++;
        }
        pending.set(event.toolCallId, {
          episodeId: `${options.sessionId()}#${event.toolCallId}`,
          sourceTool: event.toolName,
          request: buildToolMappingRequest(event.toolName, enumeration.plans, started.args as Record<string, unknown>).state,
          args: started.args as Record<string, unknown>,
          argsBytes,
          plans: enumeration.plans.map((plan) => ({ ordinal: plan.ordinal, targetTool: plan.targetTool, pairs: plan.pairs })),
          confirmedSequence: sequence,
          openedAt: now,
        });
        confirmedOrder.push(event.toolCallId);
        // The order list mirrors pending; keep it bounded even under stress.
        while (confirmedOrder.length > maxPending) confirmedOrder.shift();
        stats.episodesOpened++;
        return evicted;
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
        void 0;
        if (started.args === null || typeof started.args !== "object" || Array.isArray(started.args)) continue;
        const successArgs = started.args as Record<string, unknown>;
        const matching = episode.plans.find((meta) => {
          const derived = derivePlan(meta, episode.args);
          return derived !== undefined && planMatchesCall(derived, { id, ts: "", kind: "toolCall", toolName: event.toolName, args: successArgs });
        });
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
        const record = closureRecord(episode, reason, now);
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

/**
 * Line-level guard: the rendered JSON must contain only expected top-level
 * fields, and every nested value is re-checked so a forged extra or secret
 * field can never reach the writer.
 */
export function labelLineIsPrivacySafe(line: string): boolean {
  if (line.includes("\n")) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const expected = new Set(["ts", "eventType", "sessionId", "episodeId", "outcome", "sourceTool", "targetTool", "planOrdinal", "pairs", "request", "interveningCalls", "latencyMs"]);
  if (Object.keys(record).some((key) => !expected.has(key))) return false;
  if (record.eventType !== "prospective-label") return false;
  if (typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))) return false;
  if (!OUTCOMES.has(record.outcome as string)) return false;
  const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;
  if (typeof record.sessionId !== "string" || !OPAQUE_ID.test(record.sessionId)) return false;
  if (typeof record.episodeId !== "string" || !EPISODE_ID.test(record.episodeId)) return false;
  if (typeof record.sourceTool !== "string" || (record.sourceTool as string).length > 60) return false;
  if (typeof record.sourceTool !== "string" || !identifier.test(record.sourceTool)) return false;
  if (record.targetTool !== undefined && (typeof record.targetTool !== "string" || !identifier.test(record.targetTool))) return false;
  if (record.planOrdinal !== undefined && (!Number.isInteger(record.planOrdinal) || (record.planOrdinal as number) < 1 || (record.planOrdinal as number) > MAX_PLANS)) return false;
  if (!Array.isArray(record.pairs) || record.pairs.length > 5) return false;
  if (record.pairs.some((pair) => typeof pair !== "string" || !PAIR_PATTERN.test(pair))) return false;
  if (!Number.isInteger(record.interveningCalls) || !Number.isInteger(record.latencyMs)) return false;
  return requestStateIsSafe(record.request);
}

/** Closed key sets for the persisted judge-input snapshot. */
const REQUEST_KEYS = new Set(["attemptedTool", "failureClass", "targets", "plans", "prior"]);
const PLAN_KEYS = new Set(["ordinal", "targetTool", "fields"]);
const FIELD_KEYS = new Set(["from", "role", "features"]);
const FEATURE_KEYS = new Set(["kind", "shape", "lengthBucket", "tokenBucket", "itemBucket"]);
const PRIOR_KEYS = new Set(["priorToolNames", "priorFailedCalls"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;
/** `role<-from`: BOTH identifiers are required; an empty side fails. */
const PAIR_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,60}<-([A-Za-z_][A-Za-z0-9_-]{0,60})$/;
/**
 * Generated opaque IDs only: Pi session IDs are UUIDs and episode IDs are
 * `sessionId#toolCallId`, where call IDs use `|`, `:`, `.`, `_`, `-` and
 * alphanumerics. Arbitrary text (for example a secret with spaces) fails.
 */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:#|+-]{0,199}$/;
/** Episode IDs are always `<sessionId>#<toolCallId>`; free text has no `#`. */
const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:|+-]{0,99}#[A-Za-z0-9][A-Za-z0-9._:|+-]{0,99}$/;
/** Closed vocabularies: any value outside them fails the write. */
const OUTCOMES = new Set(["labelled", "expired", "interrupted"]);
const FEATURE_KINDS = new Set(["string", "number", "boolean", "array"]);
const FEATURE_SHAPES = new Set(["path", "prose", "code", "shell", "collection", "numeric", "boolean", "value"]);
const LENGTH_BUCKETS = new Set(["empty", "short", "medium", "long", "huge"]);
const TOKEN_BUCKETS = new Set(["zero", "one", "few", "several", "many"]);
const ITEM_BUCKETS = new Set(["one", "few", "several", "many"]);

/**
 * The replay snapshot must be exactly the closed TASK-0036 request state: an
 * unknown key anywhere (a forged secret field) fails the write.
 */
export function requestStateIsSafe(request: unknown): boolean {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const state = request as Record<string, unknown>;
  if (Object.keys(state).some((key) => !REQUEST_KEYS.has(key))) return false;
  if (typeof state.attemptedTool !== "string" || !IDENTIFIER.test(state.attemptedTool)) return false;
  if (state.failureClass !== "schema-validation") return false;
  if (!Array.isArray(state.targets) || state.targets.some((target) => typeof target !== "string" || !IDENTIFIER.test(target))) return false;
  if (!Array.isArray(state.plans)) return false;
  for (const plan of state.plans) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
    const entry = plan as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !PLAN_KEYS.has(key))) return false;
    if (typeof entry.ordinal !== "number" || typeof entry.targetTool !== "string" || !IDENTIFIER.test(entry.targetTool)) return false;
    if (!Array.isArray(entry.fields)) return false;
    for (const field of entry.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) return false;
      const spec = field as Record<string, unknown>;
      if (Object.keys(spec).some((key) => !FIELD_KEYS.has(key))) return false;
      if (typeof spec.from !== "string" || !IDENTIFIER.test(spec.from)) return false;
      if (typeof spec.role !== "string" || !IDENTIFIER.test(spec.role)) return false;
      const features = spec.features as Record<string, unknown> | undefined;
      if (!features || typeof features !== "object" || Array.isArray(features)) return false;
      if (Object.keys(features).some((key) => !FEATURE_KEYS.has(key))) return false;
      // Every feature VALUE is a closed enum: a forged secret here fails.
      if (!FEATURE_KINDS.has(features.kind as string)) return false;
      if (!FEATURE_SHAPES.has(features.shape as string)) return false;
      if (!LENGTH_BUCKETS.has(features.lengthBucket as string)) return false;
      if (!TOKEN_BUCKETS.has(features.tokenBucket as string)) return false;
      if (features.itemBucket !== undefined && !ITEM_BUCKETS.has(features.itemBucket as string)) return false;
    }
  }
  const prior = state.prior as Record<string, unknown> | undefined;
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return false;
  if (Object.keys(prior).some((key) => !PRIOR_KEYS.has(key))) return false;
  if (!Array.isArray(prior.priorToolNames) || prior.priorToolNames.some((name) => typeof name !== "string" || !IDENTIFIER.test(name))) return false;
  if (!Number.isInteger(prior.priorFailedCalls)) return false;
  return true;
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
