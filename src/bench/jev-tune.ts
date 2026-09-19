/**
 * TASK-0026 — tune the Jev question/instructions adapter and measure it per
 * fixture tier. Bounded, one variant at a time, synthetic content only.
 *
 * Scope guard: ONLY the prompt spec (instructions/abstain criteria/candidate
 * label) is tunable. Candidate generation, ordinals, fixtures, the 0.9 gate,
 * scoring, and the live runtime pipeline are untouched. Any wrong-target
 * selection is a hard failure and rejects the variant.
 *
 * Direction evidence only — never promotion evidence, never runtime mutation.
 */

import { evaluateSelector, type SelectionEvalResult } from "./edit-selection.ts";
import { JEV_PROBE_FIXTURES, PROBE_TIERS, createJevProbeSelector, jevProbeRequest, probeCase, type JevProbeSelector, type ProbeTier } from "./probe-fixtures.ts";
import { DEFAULT_JEV_PROMPT, type JevClient, type JevPromptSpec } from "../infra/typesafe.ts";

export interface JevVariant {
  id: string;
  label: string;
  prompt: JevPromptSpec;
}

export const BASELINE_VARIANT: JevVariant = {
  id: "baseline",
  label: "Baseline — live shadow prompt (unchanged)",
  prompt: DEFAULT_JEV_PROMPT,
};

/** One bounded variant at a time; evaluated independently across all tiers. */
export const TUNE_VARIANTS: readonly JevVariant[] = [
  {
    id: "v1-ambiguity-aware",
    label: "V1 — ambiguity-aware instructions",
    prompt: {
      instructions:
        "Choose the single candidate that the edit request most likely targets, using the surrounding context in each window. " +
        "Abstain only when two or more candidates remain genuinely indistinguishable.",
      abstainCriteria: "Two or more candidates are equally plausible given their surrounding context.",
      candidateCriteria: (ordinal) => `Candidate ${ordinal}`,
    },
  },
  {
    id: "v2-context-first",
    label: "V2 — context-first instructions",
    prompt: {
      instructions:
        "Each window is an alternative location of the same text. Use differences in surrounding code — identifiers, " +
        "indentation, neighboring lines — to identify the intended target. Return abstain when the windows give no distinguishing signal.",
      abstainCriteria: "No candidate is distinguishable from the others by its surrounding context.",
      candidateCriteria: (ordinal) => `Candidate ${ordinal}`,
    },
  },
];

export interface TierRun {
  tier: ProbeTier;
  fixtures: number;
  selected: number;
  correct: number;
  wrongTarget: number;
  abstained: number;
  abstentionRate: number;
  precision: number;
  selectionConfidences: number[];
  abstentionConfidences: number[];
  latencyMs: number[];
}

export interface VariantResult {
  variantId: string;
  tiers: TierRun[];
  totalSelected: number;
  totalCorrect: number;
  totalWrongTarget: number;
  totalAbstained: number;
}

export interface RunTuneVariantOptions {
  variant: JevVariant;
  client: JevClient;
  timeoutMs?: number;
  now?: () => number;
}

/** Runs one variant over all tiers through the existing eval contract. */
export async function runTuneVariant(options: RunTuneVariantOptions): Promise<VariantResult> {
  const requests = JEV_PROBE_FIXTURES.map(jevProbeRequest);
  const selector = createJevProbeSelector(options.client, requests, options.timeoutMs, options.now);
  const tiers: TierRun[] = [];
  let totalSelected = 0;
  let totalCorrect = 0;
  let totalWrongTarget = 0;
  let totalAbstained = 0;

  for (const tier of PROBE_TIERS) {
    const fixtures = JEV_PROBE_FIXTURES.filter((fixture) => fixture.tier === tier);
    const cases = fixtures.map(probeCase);
    const result: SelectionEvalResult = await evaluateSelector(cases, selector);
    const tierResponses = selector.responses.filter((entry) => fixtures.some((fixture) => fixture.caseId === entry.caseId));
    const selectionConfidences = tierResponses
      .filter((entry) => entry.response.choice !== null)
      .map((entry) => entry.response.confidence)
      .filter((confidence): confidence is number => confidence !== undefined);
    const abstentionConfidences = tierResponses
      .filter((entry) => entry.response.choice === null)
      .map((entry) => entry.response.confidence)
      .filter((confidence): confidence is number => confidence !== undefined);

    totalSelected += result.selected;
    totalCorrect += result.correct;
    totalWrongTarget += result.wrong;
    totalAbstained += result.abstained;

    tiers.push({
      tier,
      fixtures: cases.length,
      selected: result.selected,
      correct: result.correct,
      wrongTarget: result.wrong,
      abstained: result.abstained,
      abstentionRate: result.abstentionRate,
      precision: result.precision,
      selectionConfidences,
      abstentionConfidences,
      latencyMs: tierResponses.map((entry) => entry.latencyMs),
    });
  }

  return {
    variantId: options.variant.id,
    tiers,
    totalSelected,
    totalCorrect,
    totalWrongTarget,
    totalAbstained,
  };
}

export type Recommendation = "reject" | "adopt-for-shadow-evaluation" | "keep";

export interface TuneReport {
  label: "direction evidence only";
  baseline: VariantResult;
  variants: readonly VariantResult[];
  recommendation: { decision: Recommendation; reason: string };
}

export function decideRecommendation(results: readonly VariantResult[]): { decision: Recommendation; reason: string } {
  const baseline = results[0];
  for (const result of results) {
    if (result.totalWrongTarget > 0) {
      return { decision: "reject", reason: `${result.variantId}: wrong-target selection is a hard failure` };
    }
  }
  if (!baseline || results.length === 1) {
    return { decision: "keep", reason: "no variant out-selected the baseline without a wrong-target" };
  }
  const best = results.slice(1).reduce((a, b) => (b.totalCorrect > a.totalCorrect ? b : a));
  if (best.totalCorrect > baseline.totalCorrect && best.totalWrongTarget === 0) {
    return { decision: "adopt-for-shadow-evaluation", reason: `${best.variantId} selects more correct targets than baseline with zero wrong-target` };
  }
  return { decision: "keep", reason: "no variant improved correct selections over baseline" };
}

function confidenceSummary(values: readonly number[]): string {
  if (values.length === 0) return "-";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `mean ${mean.toFixed(2)} (n=${values.length})`;
}

export function renderTuneMarkdown(report: TuneReport): string {
  const lines: string[] = [];
  lines.push("# Jev ordinal-selection tuning — TASK-0026");
  lines.push("");
  lines.push(`**${report.label}** — synthetic fixtures only; never promotion evidence. Any wrong-target is a hard failure.`);
  lines.push("");
  for (const result of [report.baseline, ...report.variants]) {
    lines.push(`## ${result.variantId}`);
    lines.push("");
    lines.push("| tier | fixtures | selected | correct | wrong | abstained | abst. rate | precision | selection conf. | abstain conf. | latency (ms) |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const tier of result.tiers) {
      lines.push(
        `| ${tier.tier} | ${tier.fixtures} | ${tier.selected} | ${tier.correct} | ${tier.wrongTarget} | ${tier.abstained} | ${tier.abstentionRate.toFixed(2)} | ${tier.precision.toFixed(2)} | ${confidenceSummary(tier.selectionConfidences)} | ${confidenceSummary(tier.abstentionConfidences)} | ${latencySummary(tier.latencyMs)} |`,
      );
    }
    lines.push("");
  }
  lines.push(`## Recommendation: ${report.recommendation.decision}`);
  lines.push("");
  lines.push(report.recommendation.reason);
  lines.push("");
  return lines.join("\n");
}

function latencySummary(values: readonly number[]): string {
  if (values.length === 0) return "-";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const max = Math.max(...values);
  return `mean ${Math.round(mean)} / max ${max}`;
}

export function renderTuneJson(report: TuneReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
