/**
 * Failure report formatting — pure markdown rendering of failure clusters.
 *
 * No I/O. Turns `FailureCluster[]` into a developer-readable report so
 * recurring patterns can be studied and turned into new repair rules.
 */

import type { FailureCluster, RepairCluster } from "./aggregate.ts";

export function formatFailureReport(
  clusters: readonly FailureCluster[],
  repairs: readonly RepairCluster[] = [],
): string {
  const lines: string[] = [
    "# pi-welder failure report",
    "",
    "Source: aggregated from *.jsonl session logs",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  if (clusters.length === 0) {
    lines.push("No failures recorded.");
  }

  for (const cluster of clusters) {
    lines.push(`## ${cluster.toolName} / ${cluster.errorKind}  (×${cluster.count})`, "");
    lines.push("samples:");
    for (const sample of cluster.samples) {
      lines.push(`- ${sample.errorText}`);
      if (sample.inputKeys.length > 0) {
        lines.push(`  input keys: ${sample.inputKeys.join(", ")}`);
      }
    }
    lines.push("", "---", "");
  }

  if (repairs.length > 0) {
    lines.push("## repairs by model", "");
    for (const repair of repairs) {
      lines.push(`- ${repair.provider} / ${repair.model} / ${repair.toolName} / ${repair.action} (×${repair.count})`);
    }
    lines.push("");
  }

  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  lines.push("## totals", "");
  lines.push(`total failures: ${total}`);
  lines.push(`clusters: ${clusters.length}`);

  return lines.join("\n");
}
