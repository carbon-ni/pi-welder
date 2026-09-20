/**
 * TASK-0030 — deterministic, privacy-safe episode report + local review
 * worksheet. The shared report contains only metadata (families, recovery
 * shapes, linkage signals, counts, opaque session ids). Full episode content
 * appears exclusively in the ignored local worksheet.
 */

import type { FailedEpisode, LinkageSignals, RecoveryShape } from "./episode.ts";

export const SHAPE_ORDER: readonly RecoveryShape[] = [
  "same-tool-retry", "different-tool-recovery", "user-intervention", "unrelated-continuation", "abandonment", "unresolved",
];

export const REPORT_LABEL = "metadata only — no paths, source, commands, edit text, or conversation text";

export interface FamilyCount { family: string; count: number }
export interface ShapeCount { shape: RecoveryShape; count: number }
export interface SignalCount { signal: keyof LinkageSignals; true: number; total: number }

export interface SampleRow {
  episodeId: string;
  sessionId: string;
  family: string;
  shape: RecoveryShape;
  signals: LinkageSignals;
}

export interface MiningReport {
  label: string;
  sessions: number;
  episodes: number;
  byFamily: FamilyCount[];
  byShape: ShapeCount[];
  linkage: SignalCount[];
  sessionConcentration: { max: number; median: number; sessions: number; topSessions: { sessionId: string; episodes: number }[] };
  sample: SampleRow[];
}

const SIGNALS: readonly (keyof LinkageSignals)[] = [
  "samePathLocally", "locatorExtension", "repeatedToolShape", "nextSuccessfulCall", "interveningUnrelatedEvents",
];

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Stratified sample: for each top family, episodes are drawn round-robin across
 * distinct sessions so long sessions are not silently over-sampled.
 */
function stratifiedSample(episodes: readonly FailedEpisode[], topFamilies: readonly string[], perFamily: number): SampleRow[] {
  const sample: SampleRow[] = [];
  for (const family of topFamilies) {
    const bySession = new Map<string, FailedEpisode[]>();
    for (const episode of episodes.filter((entry) => entry.family === family).sort((a, b) => a.episodeId.localeCompare(b.episodeId))) {
      const bucket = bySession.get(episode.sessionId) ?? [];
      bucket.push(episode);
      bySession.set(episode.sessionId, bucket);
    }
    const sessionOrder = [...bySession.keys()].sort();
    let round = 0;
    while (sample.filter((row) => row.family === family).length < perFamily) {
      const picked = sessionOrder.map((sessionId) => bySession.get(sessionId)![round]).filter((entry): entry is FailedEpisode => entry !== undefined);
      if (picked.length === 0) break;
      for (const episode of picked) {
        if (sample.filter((row) => row.family === family).length >= perFamily) break;
        sample.push({ episodeId: episode.episodeId, sessionId: episode.sessionId, family: episode.family, shape: episode.shape, signals: episode.signals });
      }
      round++;
    }
  }
  return sample;
}

export function buildMiningReport(episodes: readonly FailedEpisode[], options: { topFamilies?: number; perFamily?: number } = {}): MiningReport {
  const topFamilyLimit = options.topFamilies ?? 5;
  const perFamily = options.perFamily ?? 2;

  const familyCounts = new Map<string, number>();
  const shapeCounts = new Map<RecoveryShape, number>(SHAPE_ORDER.map((shape) => [shape, 0]));
  const perSession = new Map<string, number>();
  const signalTrue = new Map<keyof LinkageSignals, number>();

  for (const episode of episodes) {
    familyCounts.set(episode.family, (familyCounts.get(episode.family) ?? 0) + 1);
    shapeCounts.set(episode.shape, (shapeCounts.get(episode.shape) ?? 0) + 1);
    perSession.set(episode.sessionId, (perSession.get(episode.sessionId) ?? 0) + 1);
    for (const signal of SIGNALS) {
      const value = episode.signals[signal];
      const counted = signal === "interveningUnrelatedEvents"
        ? typeof value === "number" && value > 0
        : value === true;
      if (counted) signalTrue.set(signal, (signalTrue.get(signal) ?? 0) + 1);
    }
  }

  const byFamily = [...familyCounts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
  const sessionCounts = [...perSession.entries()].map(([sessionId, count]) => ({ sessionId, episodes: count }));
  const topSessions = [...sessionCounts].sort((a, b) => b.episodes - a.episodes || a.sessionId.localeCompare(b.sessionId)).slice(0, 5);

  return {
    label: REPORT_LABEL,
    sessions: perSession.size,
    episodes: episodes.length,
    byFamily,
    byShape: SHAPE_ORDER.map((shape) => ({ shape, count: shapeCounts.get(shape) ?? 0 })),
    linkage: SIGNALS.map((signal) => ({ signal, true: signalTrue.get(signal) ?? 0, total: episodes.length })),
    sessionConcentration: {
      max: sessionCounts.reduce((max, entry) => Math.max(max, entry.episodes), 0),
      median: median(sessionCounts.map((entry) => entry.episodes)),
      sessions: perSession.size,
      topSessions,
    },
    sample: stratifiedSample(episodes, byFamily.slice(0, topFamilyLimit).map((entry) => entry.family), perFamily),
  };
}

/** Deterministic, privacy-safe markdown report. */
export function renderMiningReport(report: MiningReport): string {
  const lines: string[] = [
    "# Failure and recovery episodes — TASK-0030",
    "",
    `**${report.label}**`,
    "",
    `Sessions: ${report.sessions}; episodes: ${report.episodes}.`,
    "",
    "Recovery shapes and linkage signals are **structural observations of what happened next, not causal claims or intent labels**. Tool names and failure kinds are allowlisted; unrecognized values render as `unknown`/`UNKNOWN`.",
    "",
    "## Structural families",
    "",
    "| family | episodes |",
    "|---|---|",
  ];
  for (const entry of report.byFamily) lines.push(`| ${entry.family} | ${entry.count} |`);
  lines.push("", "## Recovery shapes", "", "| shape | episodes |", "|---|---|");
  for (const entry of report.byShape) lines.push(`| ${entry.shape} | ${entry.count} |`);
  lines.push("", "## Linkage signals (structural, not intent)", "", "| signal | episodes | share |", "|---|---|---|");
  for (const entry of report.linkage) {
    lines.push(`| ${entry.signal} | ${entry.true} | ${entry.total === 0 ? "0.000" : (entry.true / entry.total).toFixed(3)} |`);
  }
  lines.push(
    "",
    "## Session concentration",
    "",
    `sessions: ${report.sessionConcentration.sessions}; max episodes/session: ${report.sessionConcentration.max}; median: ${report.sessionConcentration.median}`,
    "",
    "| session | episodes |",
    "|---|---|",
  );
  for (const entry of report.sessionConcentration.topSessions) lines.push(`| ${entry.sessionId} | ${entry.episodes} |`);
  lines.push("", "## Stratified sample (round-robin across sessions)", "", "| episode | session | family | shape | samePath | locatorExt | repeatedShape | nextSuccess | intervening |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of report.sample) {
    lines.push(`| ${row.episodeId} | ${row.sessionId} | ${row.family} | ${row.shape} | ${row.signals.samePathLocally} | ${row.signals.locatorExtension} | ${row.signals.repeatedToolShape} | ${row.signals.nextSuccessfulCall} | ${row.signals.interveningUnrelatedEvents} |`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

export const WORKSHEET_COLUMNS = [
  "episodeId", "sessionId", "family", "shape",
  "samePathLocally", "locatorExtension", "repeatedToolShape", "nextSuccessfulCall", "interveningUnrelatedEvents",
  "priorSummary", "failedTool", "failureClass", "callSummary", "resultSummary", "followingSummary",
  "apparent-intent", "recovery-related", "recovery-strategy", "probabilistic-repair-candidate",
] as const;

function summarize(events: readonly { kind: string; toolName?: string; argKeys?: string[]; isError?: boolean; errorText?: string; contentText?: string; path?: string; editLocator?: string }[]): string {
  return events.map((event) => eventSummary(event)).join(" || ");
}

function eventSummary(event: { kind: string; toolName?: string; argKeys?: string[]; isError?: boolean; errorText?: string; contentText?: string; path?: string; editLocator?: string }): string {
  const parts = [event.kind];
  if (event.toolName) parts.push(event.toolName);
  if (event.path) parts.push(`path=${event.path}`);
  if (event.argKeys) parts.push(`keys=${event.argKeys.join(",")}`);
  if (event.editLocator) parts.push(`locator=${event.editLocator.replace(/\s+/g, " ").slice(0, 200)}`);
  if (event.isError !== undefined) parts.push(event.isError ? "error" : "ok");
  const text = event.errorText ?? event.contentText ?? "";
  if (text) parts.push(text.replace(/\s+/g, " ").slice(0, 400));
  return parts.join(" | ");
}

/**
 * Local review worksheet (ignored `.tmp` only). This is the ONLY artifact that
 * may carry episode content; review columns start empty for a human to fill.
 */
export function renderWorksheet(episodes: readonly FailedEpisode[]): string {
  const rows = [WORKSHEET_COLUMNS.join("\t")];
  for (const episode of episodes) {
    const cells: string[] = [
      episode.episodeId,
      episode.sessionId,
      episode.family,
      episode.shape,
      String(episode.signals.samePathLocally),
      String(episode.signals.locatorExtension),
      String(episode.signals.repeatedToolShape),
      String(episode.signals.nextSuccessfulCall),
      String(episode.signals.interveningUnrelatedEvents),
      summarize(episode.prior),
      episode.call.toolName ?? "",
      episode.result?.errorKind ?? "",
      eventSummary(episode.call),
      episode.result === undefined ? "" : eventSummary(episode.result),
      summarize(episode.following),
      "", "", "", "", // reviewer fills these
    ];
    rows.push(cells.join("\t"));
  }
  return rows.join("\n") + "\n";
}
