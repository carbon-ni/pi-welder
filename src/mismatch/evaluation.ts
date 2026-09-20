/**
 * TASK-0031 — jeq evaluation for bounded edit-mismatch candidates.
 *
 * Requests carry only closed structural features: failure class, bounded
 * pre-failure counters, and candidate ordinal + transformation/similarity/
 * length/line buckets. Never paths, source, edit text, identifiers, raw
 * conversation, or future behavior. Parsing is hardened and fails closed.
 */

import { candidateFeatures, type MismatchCandidate } from "./candidates.ts";
import type { ClosedPriorSignals, MismatchCase } from "./episode.ts";

export const MISMATCH_THRESHOLD = 0.99;
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export const MISMATCH_PROMOTION_GATE = Object.freeze({
  /** Overall candidate-set coverage (labelable / mined), not conditional recall. */
  minCoverage: 0.95,
  minHighConfidenceSelections: 30,
  confidenceThreshold: 0.99,
  maxWrong: 0,
});

export function candidateOptions(candidates: readonly MismatchCandidate[]): string[] {
  return [...candidates.map((candidate) => `candidate-${candidate.ordinal}`), "none"];
}

export interface MismatchRequestState {
  failureClass: MismatchCase["failureClass"];
  prior: ClosedPriorSignals;
  candidates: (Record<string, string | number> & { ordinal: number })[];
}

/** Closed pre-failure + candidate-feature state; contains no text or ids. */
export function buildMismatchState(evaluationCase: MismatchCase, candidates: readonly MismatchCandidate[]): MismatchRequestState {
  return {
    failureClass: evaluationCase.failureClass,
    prior: evaluationCase.prior,
    candidates: candidates.map(candidateFeatures) as MismatchRequestState["candidates"],
  };
}

export interface MismatchRequest {
  model: string;
  state: MismatchRequestState;
  questions: {
    candidate: {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };
  };
}

export const MISMATCH_INSTRUCTIONS =
  "An exact-text edit anchor was not found in the file. Choose the candidate anchor that most likely matches the file's actual content, " +
  "or none when no candidate is supported. Choose only from the listed criteria.";

export function buildMismatchRequest(evaluationCase: MismatchCase, candidates: readonly MismatchCandidate[], model = "jev-latest"): MismatchRequest {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) criteria[`candidate-${candidate.ordinal}`] = `Anchor ${candidate.ordinal} (${candidate.transform}, ${candidate.similarity})`;
  criteria.none = "No candidate anchor is supported.";
  return { model, state: buildMismatchState(evaluationCase, candidates), questions: { candidate: { type: "choice", instructions: MISMATCH_INSTRUCTIONS, criteria } } };
}

export interface MismatchResponse {
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

/** Hardened parser: choice in options; confidence/probabilities finite [0,1]; keys exact; sum ~1. */
export function parseMismatchResponse(raw: string, options: readonly string[], sumTolerance = PROBABILITY_SUM_TOLERANCE): MismatchResponse | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.candidate;
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string") return undefined;

  const optionSet = new Set(options);
  if (!optionSet.has(answer.choice)) return undefined;

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
  return { choice: answer.choice, ...(confidence === undefined ? {} : { confidence }), probabilities };
}

export interface MismatchResult {
  caseId: string;
  status: "answered" | "abstained" | "malformed" | "failed";
  choice?: string;
  /** Transformation of the chosen candidate (for per-transformation accuracy). */
  choiceTransform?: string;
  confidence?: number;
  latencyMs: number;
}

/**
 * Candidate-set coverage and conditional recall, reported separately:
 * - coverage = labelable / all mined candidate cases (end-to-end hit rate);
 * - conditional recall = matches / labelable cases.
 */
export interface CandidateSetCoverage {
  cases: number;
  labelable: number;
  coverage: number;
  top1: number;
  top5: number;
  conditionalTop1Recall: number;
  conditionalTop5Recall: number;
}

export function computeCandidateCoverage(cases: readonly { labelOrdinal?: number }[]): CandidateSetCoverage {
  const labelable = cases.filter((entry) => entry.labelOrdinal !== undefined).length;
  const top1 = cases.filter((entry) => entry.labelOrdinal === 1).length;
  const top5 = cases.filter((entry) => (entry.labelOrdinal ?? 0) >= 1 && (entry.labelOrdinal ?? 0) <= 5).length;
  return {
    cases: cases.length,
    labelable,
    coverage: cases.length === 0 ? 0 : labelable / cases.length,
    top1,
    top5,
    conditionalTop1Recall: labelable === 0 ? 0 : top1 / labelable,
    conditionalTop5Recall: labelable === 0 ? 0 : top5 / labelable,
  };
}

export interface CalibrationBucket { id: string; min: number; max?: number; attempts: number; correct: number; accuracy: number }
export interface TransformAccuracy { transform: string; attempts: number; correct: number; accuracy: number }

export interface MismatchMetrics {
  cases: number;
  attempted: number;
  correct: number;
  wrong: number;
  accuracy: number;
  abstained: number;
  malformed: number;
  failed: number;
  highConfidenceSelections: number;
  highConfidenceCorrect: number;
  precisionAtThreshold: number;
  coverage: number;
  calibration: CalibrationBucket[];
  perTransform: TransformAccuracy[];
  /** Baseline = always ordinal 1; denominator is the labelable case count. */
  baselineDenominator: number;
  baselineCorrect: number;
  baselineAccuracy: number;
  latencyMs: number;
}

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.79", min: 0.5, max: 0.8 },
  { id: "0.80-0.98", min: 0.8, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

/** Metrics plus the deterministic baseline (always candidate 1 when present). */
export function evaluateMismatch(
  labelable: readonly { caseId: string; labelOrdinal?: number }[],
  results: readonly MismatchResult[],
): MismatchMetrics {
  const byCase = new Map(results.map((result) => [result.caseId, result]));
  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  const perTransform = new Map<string, { attempts: number; correct: number }>();
  let attempted = 0;
  let correct = 0;
  let wrong = 0;
  let abstained = 0;
  let malformed = 0;
  let failed = 0;
  let highConfidenceSelections = 0;
  let highConfidenceCorrect = 0;
  let baselineCorrect = 0;
  let latencyMs = 0;

  for (const entry of labelable) {
    if (entry.labelOrdinal === 1) baselineCorrect++;
    const result = byCase.get(entry.caseId);
    if (!result) continue;
    latencyMs += result.latencyMs;
    if (result.status === "abstained") { abstained++; continue; }
    if (result.status === "malformed") { malformed++; continue; }
    if (result.status === "failed") { failed++; continue; }
    if (result.choice === "none") { abstained++; continue; }
    attempted++;
    const isCorrect = result.choice === `candidate-${entry.labelOrdinal}`;
    if (isCorrect) correct++;
    else wrong++;
    const confidence = result.confidence ?? 0;
    const bucket = calibration.find((candidate) => confidence >= candidate.min && (candidate.max === undefined || confidence < candidate.max));
    if (bucket) { bucket.attempts++; if (isCorrect) bucket.correct++; }
    if (confidence >= MISMATCH_THRESHOLD) { highConfidenceSelections++; if (isCorrect) highConfidenceCorrect++; }
    if (result.choiceTransform !== undefined) {
      const entryBucket = perTransform.get(result.choiceTransform) ?? { attempts: 0, correct: 0 };
      entryBucket.attempts++;
      if (isCorrect) entryBucket.correct++;
      perTransform.set(result.choiceTransform, entryBucket);
    }
  }
  for (const bucket of calibration) bucket.accuracy = bucket.attempts === 0 ? 0 : bucket.correct / bucket.attempts;

  const total = labelable.length;
  return {
    cases: total,
    attempted,
    correct,
    wrong,
    accuracy: attempted === 0 ? 0 : correct / attempted,
    abstained,
    malformed,
    failed,
    highConfidenceSelections,
    highConfidenceCorrect,
    precisionAtThreshold: highConfidenceSelections === 0 ? 0 : highConfidenceCorrect / highConfidenceSelections,
    coverage: total === 0 ? 0 : attempted / total,
    calibration,
    perTransform: [...perTransform.entries()]
      .map(([transform, entry]) => ({ transform, attempts: entry.attempts, correct: entry.correct, accuracy: entry.attempts === 0 ? 0 : entry.correct / entry.attempts }))
      .sort((a, b) => b.attempts - a.attempts || a.transform.localeCompare(b.transform)),
    baselineDenominator: total,
    baselineCorrect,
    baselineAccuracy: total === 0 ? 0 : baselineCorrect / total,
    latencyMs,
  };
}

export type MismatchVerdict = "promote" | "reject" | "shadow-only";

/**
 * Promotion requires candidate-set coverage >= 0.95 AND >= 30 correct
 * high-confidence selections with zero wrong. Conditional recall alone never
 * promotes: the generator must contain the answer for almost every case.
 */
export function decideMismatch(coverage: CandidateSetCoverage, metrics: MismatchMetrics, labelableCases: number): { verdict: MismatchVerdict; reason: string } {
  if (labelableCases < 30) {
    return { verdict: "reject", reason: `insufficient-labelable-cases: ${labelableCases} < 30` };
  }
  if (coverage.coverage < MISMATCH_PROMOTION_GATE.minCoverage) {
    return { verdict: "reject", reason: `candidate-set coverage ${coverage.coverage.toFixed(3)} < ${MISMATCH_PROMOTION_GATE.minCoverage} (conditional top-5 recall ${coverage.conditionalTop5Recall.toFixed(3)})` };
  }
  if (metrics.wrong > MISMATCH_PROMOTION_GATE.maxWrong) {
    return { verdict: "shadow-only", reason: `wrong selections: ${metrics.wrong} > ${MISMATCH_PROMOTION_GATE.maxWrong}` };
  }
  if (metrics.highConfidenceSelections < MISMATCH_PROMOTION_GATE.minHighConfidenceSelections) {
    return { verdict: "shadow-only", reason: `high-confidence selections: ${metrics.highConfidenceSelections} < ${MISMATCH_PROMOTION_GATE.minHighConfidenceSelections}` };
  }
  return { verdict: "promote", reason: `coverage ${coverage.coverage.toFixed(3)} with ${metrics.highConfidenceSelections} high-confidence selections and zero wrong` };
}
