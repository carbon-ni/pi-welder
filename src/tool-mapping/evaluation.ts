/**
 * TASK-0036 — dedicated typed judge contract, hardened parser, and metrics.
 *
 * This module owns its own request, prompt, answer, and parser types. It never
 * reuses the edit-selection client, request shape, or `answers.selection`
 * parsing, and it performs no runtime I/O: the offline evaluation script is the
 * only caller.
 */

import { featuresOfValue, type ValueFeatures } from "./features.ts";
import { planLabel, type MappingPlan } from "./planner.ts";

/** Dedicated prompt; distinct from any other welder question. */
export const TOOL_MAPPING_PROMPT = [
  "You judge which target tool and field mapping best explains a malformed tool call.",
  "You receive safe key tokens, canonical role names, closed value-shape features, and mapping ordinals.",
  "Select exactly one plan ordinal, or none. Never invent tools, fields, or values.",
].join(" ");

export const MAPPING_THRESHOLDS = [0.9, 0.99] as const;
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export interface ToolMappingField {
  /** Original key token (bounded identifier). */
  from: string;
  /** Canonical role name in the target schema. */
  role: string;
  features: ValueFeatures;
}

export interface ToolMappingPlanView {
  ordinal: number;
  targetTool: string;
  fields: ToolMappingField[];
}

export interface ToolMappingPrior {
  priorToolNames: string[];
  priorFailedCalls: number;
}

export interface ToolMappingRequestState {
  attemptedTool: string;
  failureClass: "schema-validation";
  targets: string[];
  plans: ToolMappingPlanView[];
  prior: ToolMappingPrior;
}

export interface ToolMappingRequest {
  model: string;
  prompt: string;
  state: ToolMappingRequestState;
  questions: { plan: { type: "choice"; instructions: string; criteria: Record<string, string> } };
}

export interface ToolMappingAnswer {
  planOrdinal: number | null;
  confidence?: number;
  probabilities: Record<string, number>;
}

export const EMPTY_PRIOR: ToolMappingPrior = { priorToolNames: [], priorFailedCalls: 0 };

export function buildToolMappingRequest(
  attemptedTool: string,
  plans: readonly MappingPlan[],
  values: Readonly<Record<string, unknown>>,
  options: { prior?: ToolMappingPrior; model?: string } = {},
): ToolMappingRequest {
  const criteria: Record<string, string> = {};
  const views = plans.map((plan) => {
    criteria[`plan-${plan.ordinal}`] = planLabel(plan);
    return {
      ordinal: plan.ordinal,
      targetTool: plan.targetTool,
      fields: plan.pairs.map((pair) => ({ from: pair.from, role: pair.to, features: featuresOfValue(values[pair.from]) })),
    } satisfies ToolMappingPlanView;
  });
  criteria.none = "No plan is sufficiently supported.";
  return {
    model: options.model ?? "tool-mapping-v1",
    prompt: TOOL_MAPPING_PROMPT,
    state: {
      attemptedTool,
      failureClass: "schema-validation",
      targets: [...new Set(plans.map((plan) => plan.targetTool))].sort(),
      plans: views,
      prior: {
        priorToolNames: (options.prior?.priorToolNames ?? []).slice(0, 3),
        priorFailedCalls: options.prior?.priorFailedCalls ?? 0,
      },
    },
    questions: { plan: { type: "choice", instructions: TOOL_MAPPING_PROMPT, criteria } },
  };
}

export function planOptions(count: number): string[] {
  return [...Array.from({ length: count }, (_, index) => `plan-${index + 1}`), "none"];
}

/** Hardened parsing of the dedicated answer shape (`answers.plan`). */
export function parseToolMappingAnswer(raw: string, options: readonly string[], sumTolerance = PROBABILITY_SUM_TOLERANCE): ToolMappingAnswer | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.plan;
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string") return undefined;
  if (!new Set(options).has(answer.choice)) return undefined;

  const confidence = answer.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return undefined;

  const rawProbabilities = answer.probabilities;
  if (!rawProbabilities || typeof rawProbabilities !== "object" || Array.isArray(rawProbabilities)) return undefined;
  const keys = Object.keys(rawProbabilities as Record<string, unknown>).sort();
  const expected = [...options].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;

  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const key of expected) {
    const value = (rawProbabilities as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
    probabilities[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > sumTolerance) return undefined;
  return {
    planOrdinal: answer.choice === "none" ? null : Number(answer.choice.slice("plan-".length)),
    ...(confidence === undefined ? {} : { confidence }),
    probabilities,
  };
}

export interface MappingThresholdMetrics { threshold: number; selections: number; correct: number; precision: number; coverage: number }
export interface MappingCalibrationBucket { id: string; min: number; max?: number; attempts: number; correct: number; accuracy: number }

export interface MappingOutcome {
  caseId: string;
  sessionId: string;
  status: "answered" | "abstained" | "malformed" | "failed";
  planOrdinal?: number;
  confidence?: number;
  latencyMs: number;
}

export interface LabelledPlanCase {
  caseId: string;
  sessionId: string;
  labelPlanOrdinal: number;
  planCount: number;
  sourceTool: string;
  targetTool: string;
  /** Deterministic baseline: ordinal 1 (sorted signature order). */
  baselineFirstPlan: number;
  /** Deterministic baseline: most identity-overlapping pair count, then ordinal. */
  baselineIdentityOverlap?: number;
}

export interface MappingMetrics {
  labelable: number;
  attempted: number;
  correct: number;
  accuracy: number;
  abstained: number;
  malformed: number;
  failed: number;
  planCountMean: number;
  ambiguity: { onePlan: number; twoPlans: number; threePlus: number };
  toolPairs: Record<string, number>;
  thresholds: MappingThresholdMetrics[];
  calibration: MappingCalibrationBucket[];
  baselineFirstCorrect: number;
  baselineFirstAccuracy: number;
  baselineIdentityCorrect: number;
  baselineIdentityDenominator: number;
  baselineIdentityAccuracy: number;
  distinctSessions: number;
  topSessionConcentration: { sessionId: string; cases: number }[];
}

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.89", min: 0.5, max: 0.9 },
  { id: "0.90-0.98", min: 0.9, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

export function evaluateMappings(labelable: readonly LabelledPlanCase[], results: readonly MappingOutcome[]): MappingMetrics {
  const byCase = new Map(results.map((result) => [result.caseId, result]));
  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  const thresholds = MAPPING_THRESHOLDS.map((threshold) => ({ threshold, selections: 0, correct: 0, precision: 0, coverage: 0 }));
  const perSession = new Map<string, number>();
  const toolPairs: Record<string, number> = {};
  const ambiguity = { onePlan: 0, twoPlans: 0, threePlus: 0 };
  let attempted = 0;
  let correct = 0;
  let abstained = 0;
  let malformed = 0;
  let failed = 0;
  let planCountTotal = 0;
  let baselineFirstCorrect = 0;
  let baselineIdentityCorrect = 0;
  let baselineIdentityDenominator = 0;

  for (const entry of labelable) {
    perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1);
    planCountTotal += entry.planCount;
    if (entry.planCount <= 1) ambiguity.onePlan++;
    else if (entry.planCount === 2) ambiguity.twoPlans++;
    else ambiguity.threePlus++;
    const pair = `${entry.sourceTool}->${entry.targetTool}`;
    toolPairs[pair] = (toolPairs[pair] ?? 0) + 1;
    if (entry.baselineFirstPlan === entry.labelPlanOrdinal) baselineFirstCorrect++;
    if (entry.baselineIdentityOverlap !== undefined) {
      baselineIdentityDenominator++;
      if (entry.baselineIdentityOverlap === entry.labelPlanOrdinal) baselineIdentityCorrect++;
    }

    const result = byCase.get(entry.caseId);
    if (!result || result.status === "abstained" || result.planOrdinal === undefined) { abstained++; continue; }
    attempted++;
    const isCorrect = result.planOrdinal === entry.labelPlanOrdinal;
    if (isCorrect) correct++;
    const confidence = result.confidence ?? 0;
    const bucket = calibration.find((candidate) => confidence >= candidate.min && (candidate.max === undefined || confidence < candidate.max));
    if (bucket) { bucket.attempts++; if (isCorrect) bucket.correct++; }
    for (const threshold of thresholds) {
      if (confidence >= threshold.threshold) {
        threshold.selections++;
        if (isCorrect) threshold.correct++;
      }
    }
  }

  for (const bucket of calibration) bucket.accuracy = bucket.attempts === 0 ? 0 : bucket.correct / bucket.attempts;
  for (const threshold of thresholds) {
    threshold.precision = threshold.selections === 0 ? 0 : threshold.correct / threshold.selections;
    threshold.coverage = labelable.length === 0 ? 0 : threshold.selections / labelable.length;
  }

  const sessions = [...perSession.entries()].map(([sessionId, cases]) => ({ sessionId, cases }));
  return {
    labelable: labelable.length,
    attempted,
    correct,
    accuracy: attempted === 0 ? 0 : correct / attempted,
    abstained,
    malformed,
    failed,
    planCountMean: labelable.length === 0 ? 0 : planCountTotal / labelable.length,
    ambiguity,
    toolPairs,
    thresholds,
    calibration,
    baselineFirstCorrect,
    baselineFirstAccuracy: labelable.length === 0 ? 0 : baselineFirstCorrect / labelable.length,
    baselineIdentityCorrect,
    baselineIdentityDenominator,
    baselineIdentityAccuracy: baselineIdentityDenominator === 0 ? 0 : baselineIdentityCorrect / baselineIdentityDenominator,
    distinctSessions: perSession.size,
    topSessionConcentration: sessions.sort((a, b) => b.cases - a.cases || a.sessionId.localeCompare(b.sessionId)).slice(0, 5),
  };
}

export type MappingVerdict = "promote" | "reject" | "shadow-only";

export const MAPPING_PROMOTION_GATE = Object.freeze({
  minCoverage: 0.95,
  minSelections: 30,
  threshold: 0.9,
  maxWrong: 0,
});

export function decideMappings(coverage: number, metrics: MappingMetrics, labelableCases: number): { verdict: MappingVerdict; reason: string } {
  if (labelableCases < MAPPING_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `insufficient-labelable-cases: ${labelableCases} < ${MAPPING_PROMOTION_GATE.minSelections}` };
  if (coverage < MAPPING_PROMOTION_GATE.minCoverage) return { verdict: "reject", reason: `candidate-set coverage ${coverage.toFixed(3)} < ${MAPPING_PROMOTION_GATE.minCoverage}` };
  const atThreshold = metrics.thresholds.find((entry) => entry.threshold === MAPPING_PROMOTION_GATE.threshold)!;
  if (atThreshold.correct < MAPPING_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `correct selections at ${MAPPING_PROMOTION_GATE.threshold}: ${atThreshold.correct} < ${MAPPING_PROMOTION_GATE.minSelections}` };
  if (atThreshold.selections - atThreshold.correct > MAPPING_PROMOTION_GATE.maxWrong) return { verdict: "reject", reason: `wrong selections at ${MAPPING_PROMOTION_GATE.threshold}: ${atThreshold.selections - atThreshold.correct}` };
  const beaten = [metrics.baselineFirstAccuracy, metrics.baselineIdentityAccuracy];
  if (beaten.some((baseline) => atThreshold.precision <= baseline)) {
    return { verdict: "shadow-only", reason: `precision ${atThreshold.precision.toFixed(3)} does not beat baselines (first ${metrics.baselineFirstAccuracy.toFixed(3)}, identity ${metrics.baselineIdentityAccuracy.toFixed(3)})` };
  }
  return { verdict: "promote", reason: `coverage ${coverage.toFixed(3)}, precision ${atThreshold.precision.toFixed(3)} at ${atThreshold.selections} selections beating both baselines` };
}
