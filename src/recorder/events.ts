import type { Repair } from "../repairs/index.ts";

export interface WelderEvent {
  ts: string;
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: string[];
  wasRepaired: boolean;
  inputKeys: string[];
  wasError?: boolean;
  errorKind?: string;
  errorText?: string;
}

interface BuildEventInput {
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: Repair[];
  inputKeys: string[];
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

export function classifyErrorKind(errorText: string): string {
  const first = errorText.split(/\s|:/)[0]?.trim();
  if (first && /^[A-Z][A-Z0-9_]+$/.test(first)) return first;

  const lower = errorText.toLowerCase();
  if (lower.includes("oldtext must not be empty")) return "EDIT_EMPTY_ANCHOR";
  if (lower.includes("validation failed for tool \"edit\"")) return "EDIT_INVALID_SHAPE";
  if (lower.includes("replacement produced identical content")) return "EDIT_NOOP";
  if (lower.includes("edits[") && lower.includes("overlap")) return "EDIT_OVERLAP";
  if (lower.includes("oldtext") && (lower.includes("must be unique") || lower.includes("occurrences"))) {
    return "EDIT_NOT_UNIQUE";
  }
  if (lower.includes("oldtext") && (lower.includes("could not find") || lower.includes("not found") || lower.includes("must match"))) {
    return "EDIT_NOT_FOUND";
  }
  if (lower.includes("enoent") || lower.includes("no such file")) return "ENOENT";
  if (lower.includes("edit_mismatch") || lower.includes("oldtext")) return "EDIT_MISMATCH";
  if (lower.includes("schema") || lower.includes("invalid") || lower.includes("expected")) return "SCHEMA";
  return "TOOL_ERROR";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
