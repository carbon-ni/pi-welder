/**
 * Failure aggregation — pure reduction of logged events into ranked clusters.
 *
 * Groups error events by `(toolName, errorKind)` so a developer can study
 * recurring failure shapes and decide which deserve new repair rules.
 *
 * No I/O, no clocks, no Pi APIs. Pure input → output.
 */

import type { WelderEvent } from "./events.ts";

export interface FailureSample {
  errorText: string;
  inputKeys: string[];
  ts: string;
}

export interface FailureCluster {
  toolName: string;
  errorKind: string;
  count: number;
  samples: FailureSample[];
}

export interface AggregateOptions {
  /** Max distinct error samples kept per cluster. Newest samples win. */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 3;

export function aggregateFailures(
  events: readonly WelderEvent[],
  options: AggregateOptions = {},
): FailureCluster[] {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const map = new Map<string, FailureCluster>();

  for (const ev of events) {
    if (!ev.wasError) continue;
    const errorKind = ev.errorKind ?? "TOOL_ERROR";
    const key = `${ev.toolName}\0${errorKind}`;
    const cluster = map.get(key) ?? { toolName: ev.toolName, errorKind, count: 0, samples: [] };
    cluster.count += 1;

    const errorText = ev.errorText ?? "";
    if (errorText && !cluster.samples.some((s) => s.errorText === errorText)) {
      cluster.samples.push({ errorText, inputKeys: ev.inputKeys, ts: ev.ts });
    }
    map.set(key, cluster);
  }

  for (const cluster of map.values()) {
    if (cluster.samples.length > maxSamples) {
      cluster.samples = cluster.samples.slice(-maxSamples);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.toolName.localeCompare(b.toolName);
  });
}
