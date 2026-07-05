/**
 * Failure report formatting — pure markdown rendering of failure clusters.
 *
 * No I/O. Turns `FailureCluster[]` into a developer-readable report so
 * recurring patterns can be studied and turned into new repair rules.
 */

import type { FailureCluster } from "./aggregate.ts";

export function formatFailureReport(clusters: readonly FailureCluster[]): string {
  const lines: string[] = [
    "# pi-welder failure report",
    "",
    "Source: aggregated from *.jsonl session logs",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  if (clusters.length === 0) {
    lines.push("No failures recorded.");
    return lines.join("\n");
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

  const total = clusters.reduce((sum, c) => sum + c.count, 0);
  lines.push("## totals", "");
  lines.push(`total failures: ${total}`);
  lines.push(`clusters: ${clusters.length}`);

  return lines.join("\n");
}
