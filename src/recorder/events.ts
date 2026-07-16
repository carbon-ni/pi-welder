import type { Repair } from "../repairs/index.ts";

export interface WelderEvent {
  ts: string;
  eventType: "tool_call" | "tool_result" | "model_recovery";
  toolName: string;
  provider: string;
  model: string;
  repairs: string[];
  wasRepaired: boolean;
  inputKeys: string[];
  wasError?: boolean;
  errorKind?: string;
  errorText?: string;
  recoveryStage?: string;
  recoveryOutcome?: string;
  recoveryReason?: string;
  durationMs?: number;
  confidence?: number;
  editCount?: number;
  unresolvedEditCount?: number;
  fileBytes?: number;
}

interface BuildEventInput {
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: Repair[];
  inputKeys: string[];
}

export interface BuildModelRecoveryEventInput {
  toolName: string;
  provider: string;
  model: string;
  stage: string;
  outcome: string;
  reason?: string;
  durationMs?: number;
  confidence?: number;
  editCount?: number;
  unresolvedEditCount?: number;
  fileBytes?: number;
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

export function buildModelRecoveryEvent(input: BuildModelRecoveryEventInput): WelderEvent {
  return {
    ts: new Date().toISOString(), eventType: "model_recovery", toolName: input.toolName,
    provider: input.provider, model: input.model, repairs: [], wasRepaired: input.outcome === "success", inputKeys: [],
    recoveryStage: input.stage, recoveryOutcome: input.outcome, recoveryReason: input.reason,
    durationMs: input.durationMs, confidence: input.confidence, editCount: input.editCount,
    unresolvedEditCount: input.unresolvedEditCount, fileBytes: input.fileBytes,
  };
}

export function classifyErrorKind(errorText: string): string {
  const first = errorText.split(/\s|:/)[0]?.trim();
  if (first && /^[A-Z][A-Z0-9_]+$/.test(first)) return first;
  const lower = errorText.toLowerCase();
  if (lower.includes("enoent") || lower.includes("no such file")) return "ENOENT";
  if (lower.includes("edit_mismatch") || lower.includes("oldtext")) return "EDIT_MISMATCH";
  if (lower.includes("schema") || lower.includes("invalid") || lower.includes("expected")) return "SCHEMA";
  return "TOOL_ERROR";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
