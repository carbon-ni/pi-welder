import type { Repair, RepairValidation } from "../repairs/index.ts";

export interface Stats {
  totalToolCalls: number;
  repairedToolCalls: number;
  /** Result-side recoveries (verified patch, no input change). */
  recoveredResults: number;
  /** Diagnostic-only enrichment. Never counted as a repair. */
  enrichedResults: number;
  failedToolResults: number;
  validationChecks: number;
  validationsPassed: number;
  validationsFailed: number;
  validationRejectedRepairs: number;
  failuresByTool: Map<string, number>;
  repairsByAction: Map<string, number>;
  recoveriesByAction: Map<string, number>;
  enrichmentsByAction: Map<string, number>;
  sessionId: string | null;
}

/**
 * TASK-0039 — diagnostic enrichment: the result gains context, nothing is
 * transformed and nothing is repaired, so it is never counted as a repair.
 */
const ENRICHMENT_ACTIONS: ReadonlySet<string> = new Set(["missing-read-context"]);

/** Fresh per-session counters. */
export function createStats(): Stats {
  return {
    totalToolCalls: 0,
    repairedToolCalls: 0,
    recoveredResults: 0,
    enrichedResults: 0,
    failedToolResults: 0,
    validationChecks: 0,
    validationsPassed: 0,
    validationsFailed: 0,
    validationRejectedRepairs: 0,
    failuresByTool: new Map(),
    repairsByAction: new Map(),
    recoveriesByAction: new Map(),
    enrichmentsByAction: new Map(),
    sessionId: null,
  };
}

/** Fold a list of repairs for one tool call into session stats. */
export function recordRepairs(stats: Stats, repairs: Repair[]): void {
  if (repairs.length === 0) return;
  stats.repairedToolCalls += 1;
  for (const r of repairs) {
    stats.repairsByAction.set(r.action, (stats.repairsByAction.get(r.action) ?? 0) + 1);
  }
}

/**
 * TASK-0039 — verified result recovery. The result is patched after a real
 * verification step; the tool input was never changed, so this is not an
 * input repair and never counts in `repairedToolCalls`.
 */
export function recordRecovery(stats: Stats, repairs: Repair[]): void {
  if (repairs.length === 0) return;
  stats.recoveredResults += 1;
  for (const r of repairs) {
    stats.recoveriesByAction.set(r.action, (stats.recoveriesByAction.get(r.action) ?? 0) + 1);
  }
}

/** TASK-0039 — diagnostic enrichment: context only, never a repair. */
export function recordEnrichment(stats: Stats, repairs: Repair[]): void {
  if (repairs.length === 0) return;
  stats.enrichedResults += 1;
  for (const r of repairs) {
    stats.enrichmentsByAction.set(r.action, (stats.enrichmentsByAction.get(r.action) ?? 0) + 1);
  }
}

/**
 * Folds one result-side patch into the right category: enrichment for
 * diagnostic-only context, recovery for everything else. The patch itself is
 * applied by the caller and is never changed here.
 */
export function recordResultRepairStats(stats: Stats, repairs: Repair[]): void {
  const enrichments = repairs.filter((r) => ENRICHMENT_ACTIONS.has(r.action));
  const recoveries = repairs.filter((r) => !ENRICHMENT_ACTIONS.has(r.action));
  if (recoveries.length > 0) recordRecovery(stats, recoveries);
  if (enrichments.length > 0) recordEnrichment(stats, enrichments);
}

export function recordValidation(stats: Stats, validation: RepairValidation | undefined): void {
  if (!validation?.checked) return;
  stats.validationChecks += 1;
  if (validation.passed) stats.validationsPassed += 1;
  else stats.validationsFailed += 1;
  if (validation.rejected) stats.validationRejectedRepairs += 1;
}

export function recordToolFailure(stats: Stats, toolName: string): void {
  stats.failedToolResults += 1;
  stats.failuresByTool.set(toolName, (stats.failuresByTool.get(toolName) ?? 0) + 1);
}

function countRows(counts: Map<string, number>, denominator: number): string[] {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const widest = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([action, count]) => {
    const pct = denominator ? Math.round((count / denominator) * 100) : 0;
    return `  ${action.padEnd(widest)}  ${String(count).padStart(4)}  ${pct}%`;
  });
}

/** Human-readable one-shot summary for the `/welder-stats` command. */
export function statsSummary(stats: Stats): string {
  const total = stats.totalToolCalls;
  const repaired = stats.repairedToolCalls;
  const totalRepairs = [...stats.repairsByAction.values()].reduce((a, b) => a + b, 0);

  const lines: string[] = ["📊 pi-welder — repair stats (this session)", ""];
  lines.push(`tool calls seen : ${total}`);
  lines.push(`calls repaired  : ${repaired}${total ? ` (${Math.round((repaired / total) * 100)}%)` : ""}`);
  lines.push(`repairs applied : ${totalRepairs}`);
  lines.push(`validations    : ${stats.validationChecks}`);
  if (stats.validationChecks > 0) {
    lines.push(`  passed       : ${stats.validationsPassed}`);
    lines.push(`  failed       : ${stats.validationsFailed}`);
    lines.push(`  rejected     : ${stats.validationRejectedRepairs}`);
  }
  lines.push(`failed results : ${stats.failedToolResults}`);

  if (stats.repairsByAction.size > 0) {
    lines.push("", "by repair action (input transformed or routed):");
    for (const line of countRows(stats.repairsByAction, totalRepairs)) lines.push(line);
  } else {
    lines.push("", "(no repairs needed yet — inputs have been clean)");
  }

  lines.push("", "result recoveries (verified patch, input unchanged):");
  if (stats.recoveriesByAction.size > 0) {
    lines.push(`  recovered results : ${stats.recoveredResults}`);
    for (const line of countRows(stats.recoveriesByAction, stats.recoveredResults)) lines.push(line);
  } else {
    lines.push("  none");
  }

  lines.push("", "diagnostic enrichments (context only, never a repair):");
  if (stats.enrichmentsByAction.size > 0) {
    lines.push(`  enriched results  : ${stats.enrichedResults}`);
    for (const line of countRows(stats.enrichmentsByAction, stats.enrichedResults)) lines.push(line);
  } else {
    lines.push("  none");
  }

  if (stats.failuresByTool.size > 0) {
    lines.push("", "by failed tool:");
    const rows = [...stats.failuresByTool.entries()].sort((a, b) => b[1] - a[1]);
    const widest = Math.max(...rows.map((r) => r[0].length));
    for (const [tool, count] of rows) {
      const pct = stats.failedToolResults ? Math.round((count / stats.failedToolResults) * 100) : 0;
      lines.push(`  ${tool.padEnd(widest)}  ${String(count).padStart(4)}  ${pct}%`);
    }
  }
  return lines.join("\n");
}
