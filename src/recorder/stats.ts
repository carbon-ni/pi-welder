import type { Repair } from "../repairs/index.ts";

export interface Stats {
  totalToolCalls: number;
  repairedToolCalls: number;
  failedToolResults: number;
  failuresByTool: Map<string, number>;
  repairsByAction: Map<string, number>;
  sessionId: string | null;
}

/** Fresh per-session counters. */
export function createStats(): Stats {
  return {
    totalToolCalls: 0,
    repairedToolCalls: 0,
    failedToolResults: 0,
    failuresByTool: new Map(),
    repairsByAction: new Map(),
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

export function recordToolFailure(stats: Stats, toolName: string): void {
  stats.failedToolResults += 1;
  stats.failuresByTool.set(toolName, (stats.failuresByTool.get(toolName) ?? 0) + 1);
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
  lines.push(`failed results : ${stats.failedToolResults}`);

  if (stats.repairsByAction.size > 0) {
    lines.push("", "by repair action:");
    const rows = [...stats.repairsByAction.entries()].sort((a, b) => b[1] - a[1]);
    const widest = Math.max(...rows.map((r) => r[0].length));
    for (const [action, count] of rows) {
      const pct = totalRepairs ? Math.round((count / totalRepairs) * 100) : 0;
      lines.push(`  ${action.padEnd(widest)}  ${String(count).padStart(4)}  ${pct}%`);
    }
  } else {
    lines.push("", "(no repairs needed yet — inputs have been clean)");
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
