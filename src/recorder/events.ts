import type { Repair } from "../repairs/index.ts";
import type { ShadowEvidence } from "../model-recovery/jev-shadow.ts";

export interface WelderEvent {
  ts: string;
  eventType: "tool_call" | "tool_result" | "episode" | "shadow";
  toolName: string;
  provider: string;
  model: string;
  repairs: string[];
  wasRepaired: boolean;
  inputKeys: string[];
  /** Routing audit: the tool a blocked call was routed to. Never a payload. */
  targetTool?: string;
  wasError?: boolean;
  errorKind?: string;
  errorText?: string;
  /** Episode-only fields (privacy-safe metadata, no content). */
  episodeId?: string;
  kind?: string;
  outcome?: string;
  window?: number;
  unrelatedCalls?: number;
  /** Shadow-only metadata. Never contains paths, source, edit text, or payloads. */
  toolCallId?: string;
  candidateCount?: number;
  selectedOrdinal?: number;
  confidence?: number;
  latencyMs?: number;
  decisionModel?: string;
  labelStatus?: string;
}

interface BuildEventInput {
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: Repair[];
  inputKeys: string[];
  targetTool?: string;
}

interface BuildToolResultEventInput {
  toolName: string;
  provider: string;
  model: string;
  inputKeys: string[];
  errorText: string;
}

/** Assemble an event from inputs (ts stamped at call time). */
export function buildEvent(input: BuildEventInput): WelderEvent {
  return {
    ts: new Date().toISOString(),
    eventType: input.eventType,
    toolName: input.toolName,
    provider: input.provider,
    model: input.model,
    repairs: input.repairs.map((r) => r.action),
    wasRepaired: input.repairs.length > 0,
    inputKeys: input.inputKeys,
    ...(input.targetTool === undefined ? {} : { targetTool: input.targetTool }),
  };
}

export function buildToolResultEvent(input: BuildToolResultEventInput): WelderEvent {
  return {
    ts: new Date().toISOString(),
    eventType: "tool_result",
    toolName: input.toolName,
    provider: input.provider,
    model: input.model,
    repairs: [],
    wasRepaired: false,
    inputKeys: input.inputKeys,
    wasError: true,
    errorKind: classifyErrorKind(input.errorText),
    errorText: truncate(input.errorText, 500),
  };
}

import type { EpisodeRecord } from "../episodes.ts";

export function buildShadowEvent(
  evidence: ShadowEvidence,
  meta: { provider: string; model: string },
  nowMs = Date.now(),
): WelderEvent {
  const decisionModel = evidence.model?.match(/^[A-Za-z0-9._:/-]{1,80}$/)?.[0];
  return {
    ts: new Date(nowMs).toISOString(),
    eventType: "shadow",
    toolName: "edit",
    provider: meta.provider,
    model: meta.model,
    repairs: [],
    wasRepaired: false,
    inputKeys: [],
    toolCallId: evidence.toolCallId,
    candidateCount: evidence.candidateCount,
    ...(evidence.selectedOrdinal === undefined ? {} : { selectedOrdinal: evidence.selectedOrdinal }),
    ...(evidence.confidence === undefined ? {} : { confidence: evidence.confidence }),
    latencyMs: evidence.latencyMs,
    ...(decisionModel === undefined ? {} : { decisionModel }),
    outcome: evidence.status,
    labelStatus: evidence.labelStatus,
  };
}

export function buildEpisodeEvent(record: EpisodeRecord, nowMs: number): WelderEvent {
  return {
    ts: new Date(nowMs).toISOString(),
    eventType: "episode",
    toolName: record.toolName,
    provider: record.provider,
    model: record.model,
    repairs: record.repairs,
    wasRepaired: false,
    inputKeys: record.inputKeys,
    episodeId: record.episodeId,
    kind: record.kind,
    outcome: record.outcome,
    window: record.window,
    unrelatedCalls: record.unrelatedCalls,
  };
}

export function classifyErrorKind(errorText: string): string {
  const first = errorText.split(/\s|:/)[0]?.trim();
  if (first && /^[A-Z][A-Z0-9_]+$/.test(first)) return first;

  const lower = errorText.toLowerCase();
  if (lower.includes("oldtext must not be empty")) return "EDIT_EMPTY_ANCHOR";
  if (lower.includes("validation failed for tool \"edit\"")) return "EDIT_INVALID_SHAPE";
  if (lower.includes("replacement produced identical content")) return "EDIT_NOOP";
  if (lower.includes("edits[") && lower.includes("overlap")) return "EDIT_OVERLAP";
  if (isDuplicateEditError(lower)) return "EDIT_NOT_UNIQUE";
  if (lower.includes("oldtext") && (lower.includes("could not find") || lower.includes("not found") || lower.includes("must match"))) {
    return "EDIT_NOT_FOUND";
  }
  if (lower.includes("enoent") || lower.includes("no such file")) return "ENOENT";
  if (lower.includes("edit_mismatch") || lower.includes("oldtext")) return "EDIT_MISMATCH";
  if (lower.includes("schema") || lower.includes("invalid") || lower.includes("expected")) return "SCHEMA";
  return "TOOL_ERROR";
}

function isDuplicateEditError(lowerErrorText: string): boolean {
  const hasOldTextMarker = lowerErrorText.includes("oldtext");
  const hasDuplicateMarker = lowerErrorText.includes("must be unique") || lowerErrorText.includes("occurrences");
  if (hasOldTextMarker && hasDuplicateMarker) return true;

  return lowerErrorText.includes("occurrences")
    && lowerErrorText.includes("unique")
    && lowerErrorText.includes("text");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
