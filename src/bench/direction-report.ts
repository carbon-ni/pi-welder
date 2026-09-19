/**
 * TASK-0025 direction report: per-instinct scores, fixture repair yields,
 * flagged dead rules, and Jev probe tier curves in one deterministic artifact.
 *
 * Governance line (fixed): direction evidence only. Fixture scores never
 * count toward promotion gates and never justify runtime changes.
 */

import type { YieldReport } from "./instincts.ts";
import type { ProbeTier } from "./probe-fixtures.ts";
import type { SelectionEvalResult } from "./edit-selection.ts";

export interface BaselineScore {
  population: "P1" | "P2";
  episodes: number;
  candidate: string;
  score: number;
  observed: number;
  successes: number;
  expired: number;
  byOutcome: Record<string, number>;
}

export interface ProbeTierResult {
  tier: ProbeTier;
  fixtures: number;
  selectorId: string;
  selected: number;
  correct: number;
  wrong: number;
  abstained: number;
  abstentionRate: number;
  precision: number;
}

export interface DirectionReport {
  label: "direction evidence only";
  baselines: readonly BaselineScore[];
  yield: YieldReport;
  probe: {
    totalFixtures: number;
    tiers: readonly { tier: ProbeTier; fixtures: number }[];
    executed: boolean;
    tierResults: readonly ProbeTierResult[];
  };
}

/** Deterministic JSON serialization (stable key order by construction). */
export function renderDirectionJson(report: DirectionReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function renderDirectionMarkdown(report: DirectionReport): string {
  const lines: string[] = [];
  lines.push("# Welder direction evals — TASK-0025");
  lines.push("");
  lines.push(`**${report.label}** — fixture scores never count toward promotion gates and never justify runtime changes.`);
  lines.push("");

  lines.push("## Phase 1 — bench baselines (recorded outcomes, current code)");
  lines.push("");
  lines.push("| population | candidate | episodes | observed | successes | expired | score |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const baseline of report.baselines) {
    lines.push(
      `| ${baseline.population} | ${baseline.candidate} | ${baseline.episodes} | ${baseline.observed} | ${baseline.successes} | ${baseline.expired} | ${baseline.score.toFixed(3)} |`,
    );
  }
  lines.push("");

  lines.push("## Phase 1 — repair yield over the fixture suite");
  lines.push("");
  lines.push(`Fixtures: ${report.yield.total}; resolved: ${report.yield.resolved}; matched expectations: ${report.yield.matchedExpectations}.`);
  lines.push("");
  lines.push("| rule | eligible fixtures | fired | yield |");
  lines.push("|---|---|---|---|");
  for (const rule of report.yield.rules) {
    lines.push(`| ${rule.rule} | ${rule.eligibleFixtures} | ${rule.fired} | ${rule.yieldRate.toFixed(2)} |`);
  }
  lines.push("");
  lines.push(report.yield.deadRules.length > 0
    ? `Dead rules (never fire on this suite): ${report.yield.deadRules.join(", ")}.`
    : "No dead rules: every active rule fired at least once.");
  lines.push("");

  lines.push("## Phase 2 — Jev confidence-probe fixtures");
  lines.push("");
  lines.push(`Fixtures: ${report.probe.totalFixtures}; real-API probe ${report.probe.executed ? "executed" : "not executed (gated behind --execute)"}.`);
  lines.push("");
  lines.push("| tier | fixtures | selector | selected | correct | wrong | abstained | abstention rate | precision |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const tier of report.probe.tiers) {
    const results = report.probe.tierResults.filter((result) => result.tier === tier.tier);
    if (results.length === 0) {
      lines.push(`| ${tier.tier} | ${tier.fixtures} | — | | | | | | |`);
      continue;
    }
    for (const result of results) {
      lines.push(
        `| ${result.tier} | ${tier.fixtures} | ${result.selectorId} | ${result.selected} | ${result.correct} | ${result.wrong} | ${result.abstained} | ${result.abstentionRate.toFixed(2)} | ${result.precision.toFixed(2)} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
