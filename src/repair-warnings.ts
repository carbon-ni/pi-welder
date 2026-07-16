/**
 * Repair warnings — turns applied repairs into compact model hints.
 *
 * When the welder repairs a tool call, the model gets a brief system message
 * on the next context so it learns not to repeat the same structural mistake.
 *
 * Pure: no side effects, no Pi APIs. Callers own state lifecycle.
 */

import type { Repair, RepairAction } from "./repairs/index.ts";

export interface RepairWarningRecord {
  toolName: string;
  repairs: Repair[];
  ts: string;
}

export interface RepairWarningState {
  warnings: RepairWarningRecord[];
  maxWarnings: number;
  deliveredSnapshot: string | null;
}

export interface RepairWarningMessage {
  role: "system";
  content: string;
}

export function createRepairWarningState(maxWarnings = 5): RepairWarningState {
  return { warnings: [], maxWarnings, deliveredSnapshot: null };
}

export function recordRepairWarnings(
  state: RepairWarningState,
  repairs: Repair[],
  toolName: string,
): void {
  if (repairs.length === 0) return;

  // Deduplicate by (field, action) within a single call batch
  const seen = new Set<string>();
  const deduped = repairs.filter((r) => {
    const key = `${r.field}\0${r.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  state.warnings.push({
    toolName,
    repairs: deduped,
    ts: new Date().toISOString(),
  });

  if (state.warnings.length > state.maxWarnings) {
    state.warnings = state.warnings.slice(-state.maxWarnings);
  }
  state.deliveredSnapshot = null;
}

const HINT_MAP: ReadonlyMap<RepairAction, string> = new Map([
  ["strip-null", "omit nullable fields instead of passing null"],
  ["strip-null-like", "omit nullable fields instead of passing null-like strings"],
  ["clean-path", "pass a plain path instead of a markdown link"],
  ["parse-json", "pass a parsed object/array instead of a JSON string"],
  ["wrap-array", "wrap single values in an array"],
  ["wrap-object-array", "wrap single objects in an array"],
  ["split-string", "pass an array instead of a comma-separated string"],
  ["coerce-boolean", "pass true/false instead of string booleans"],
  ["coerce-number", "pass a number instead of a numeric string"],
  ["strip-extra-props", "array items had extra properties stripped; only include allowed fields"],
  ["rename-aliased-field", "use the canonical field name for this tool"],
  ["relational-default", "when passing limit/offset, provide both together"],
  ["nest-edit-fields", "pass edits as an array of {oldText, newText} objects"],
  ["model-locate-old-text", "read current file text before composing exact replacements"],
]);

export function buildRepairWarnings(state: RepairWarningState): RepairWarningMessage[] {
  if (state.warnings.length === 0) return [];

  const lines: string[] = [];
  lines.push("pi-welder repair hints: recent tool calls were repaired. To avoid these repairs next time:");

  for (const record of state.warnings) {
    for (const repair of record.repairs) {
      const hint = HINT_MAP.get(repair.action);
      if (hint) {
        lines.push(`- ${repair.action} (${repair.field}): ${hint}`);
      } else {
        lines.push(`- ${repair.action} (${repair.field})`);
      }
    }
  }

  return [{ role: "system", content: lines.join("\n") }];
}

export function consumeRepairWarnings(state: RepairWarningState): RepairWarningMessage[] {
  const snapshot = warningsSnapshot(state);
  if (!snapshot || snapshot === state.deliveredSnapshot) return [];
  const messages = buildRepairWarnings(state);
  if (messages.length > 0) state.deliveredSnapshot = snapshot;
  return messages;
}

export function clearRepairWarnings(state: RepairWarningState): void {
  state.warnings = [];
  state.deliveredSnapshot = null;
}

export function repairWarningsSummary(state: RepairWarningState): string {
  if (state.warnings.length === 0) return "pi-welder: no pending repair warnings";

  const lines = ["pi-welder pending repair warnings"];
  for (const record of state.warnings) {
    for (const repair of record.repairs) {
      lines.push(`- ${repair.action} (${repair.field})`);
    }
  }
  return lines.join("\n");
}

function warningsSnapshot(state: RepairWarningState): string {
  if (state.warnings.length === 0) return "";
  return state.warnings
    .map((r) => [r.toolName, r.ts, ...r.repairs.map((rep) => `${rep.field}:${rep.action}`)].join("\0"))
    .join("\0\0");
}
