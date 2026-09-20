/**
 * TASK-0032 — jeq evaluation for non-unique occurrence selection.
 *
 * Requests carry only closed pre-failure signals and per-occurrence structural
 * features: ordinal, position bucket, recent-read relation/distance, and
 * required-context-length bucket. Never paths, source, edit text, identifiers,
 * commands, credentials, raw conversation, or future behavior.
 */

import type { OccurrenceCandidate, ContextLengthBucket, PositionBucket } from "./source.ts";
import type { OccurrenceEpisode } from "./episode.ts";

export const OCCURRENCE_THRESHOLDS = [0.9, 0.99] as const;
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export type ReadRelation = "none" | "before" | "after";
export type ReadDistanceBucket = "near" | "mid" | "far" | "unknown";

export interface OccurrenceFeatures {
  ordinal: number;
  position: PositionBucket;
  readRelation: ReadRelation;
  readDistance: ReadDistanceBucket;
  contextLength: ContextLengthBucket;
}

export function readDistanceBucketOf(distanceLines: number | undefined): ReadDistanceBucket {
  if (distanceLines === undefined) return "unknown";
  if (distanceLines <= 5) return "near";
  if (distanceLines <= 20) return "mid";
  return "far";
}

export interface OccurrenceRequestState {
  /** Count of occurrences in the reconstructed source. */
  occurrences: number;
  recentReadRelation: ReadRelation;
  candidates: OccurrenceFeatures[];
}

export function buildOccurrenceState(episode: OccurrenceEpisode, features: readonly OccurrenceFeatures[]): OccurrenceRequestState {
  return {
    occurrences: episode.occurrences,
    recentReadRelation: episode.priorReadOffset === undefined ? "none" : "before",
    candidates: [...features],
  };
}

export const OCCURRENCE_INSTRUCTIONS =
  "An edit anchor matches several places in the file. Based ONLY on the structural context, choose the occurrence ordinal the edit most likely targets, " +
  "or none when the evidence is insufficient. Choose only from the listed criteria.";

export interface OccurrenceRequest {
  model: string;
  state: OccurrenceRequestState;
  questions: { occurrence: { type: "choice"; instructions: string; criteria: Record<string, string> } };
}

export function buildOccurrenceRequest(episode: OccurrenceEpisode, features: readonly OccurrenceFeatures[], model = "jev-latest"): OccurrenceRequest {
  const criteria: Record<string, string> = {};
  for (const feature of features) {
    criteria[`candidate-${feature.ordinal}`] = `Occurrence ${feature.ordinal} (${feature.position}, context ${feature.contextLength}, read ${feature.readRelation}/${feature.readDistance})`;
  }
  criteria.none = "No occurrence is sufficiently supported.";
  return { model, state: buildOccurrenceState(episode, features), questions: { occurrence: { type: "choice", instructions: OCCURRENCE_INSTRUCTIONS, criteria } } };
}

export interface OccurrenceResponse {
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

/** Hardened parser: choice in criteria; confidence/probabilities finite [0,1]; keys exact; sum ~1. */
export function parseOccurrenceResponse(raw: string, options: readonly string[], sumTolerance = PROBABILITY_SUM_TOLERANCE): OccurrenceResponse | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.occurrence;
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
  return { choice: answer.choice, ...(confidence === undefined ? {} : { confidence }), probabilities };
}

export function occurrenceOptions(candidates: readonly OccurrenceCandidate[]): string[] {
  return [...candidates.map((candidate) => `candidate-${candidate.ordinal}`), "none"];
}

export interface ThresholdMetrics { threshold: number; selections: number; correct: number; precision: number; coverage: number }
export interface CalibrationBucket { id: string; min: number; max?: number; attempts: number; correct: number; accuracy: number }

export interface OccurrenceMetrics {
  labelable: number;
  attempted: number;
  correct: number;
  accuracy: number;
  abstained: number;
  malformed: number;
  failed: number;
  thresholds: ThresholdMetrics[];
  calibration: CalibrationBucket[];
  baselineFirstCorrect: number;
  baselineFirstAccuracy: number;
  baselineNearestDenominator: number;
  baselineNearestCorrect: number;
  baselineNearestAccuracy: number;
  distinctSessions: number;
  topSessionConcentration: { sessionId: string; cases: number }[];
  latencyMs: number;
}

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.89", min: 0.5, max: 0.9 },
  { id: "0.90-0.98", min: 0.9, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

export interface OccurrenceResult {
  caseId: string;
  sessionId: string;
  status: "answered" | "abstained" | "malformed" | "failed";
  choice?: string;
  confidence?: number;
  latencyMs: number;
}

export interface LabelableCase {
  caseId: string;
  sessionId: string;
  labelOrdinal: number;
  baselineNearest?: number;
}

export function evaluateOccurrences(labelable: readonly LabelableCase[], results: readonly OccurrenceResult[]): OccurrenceMetrics {
  const byCase = new Map(results.map((result) => [result.caseId, result]));
  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  const thresholds = OCCURRENCE_THRESHOLDS.map((threshold) => ({ threshold, selections: 0, correct: 0, precision: 0, coverage: 0 }));
  const perSession = new Map<string, number>();
  let attempted = 0;
  let correct = 0;
  let abstained = 0;
  let malformed = 0;
  let failed = 0;
  let baselineFirstCorrect = 0;
  let baselineNearestDenominator = 0;
  let baselineNearestCorrect = 0;
  let latencyMs = 0;

  for (const entry of labelable) {
    perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1);
    if (entry.labelOrdinal === 1) baselineFirstCorrect++;
    if (entry.baselineNearest !== undefined) {
      baselineNearestDenominator++;
      if (entry.baselineNearest === entry.labelOrdinal) baselineNearestCorrect++;
    }
    const result = byCase.get(entry.caseId);
    if (!result) continue;
    latencyMs += result.latencyMs;
    if (result.status === "abstained") { abstained++; continue; }
    if (result.status === "malformed") { malformed++; continue; }
    if (result.status === "failed") { failed++; continue; }
    if (result.choice === undefined || result.choice === "none") { abstained++; continue; }
    attempted++;
    const isCorrect = result.choice === `candidate-${entry.labelOrdinal}`;
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

  const total = labelable.length;
  const sessions = [...perSession.entries()].map(([sessionId, cases]) => ({ sessionId, cases }));
  return {
    labelable: total,
    attempted,
    correct,
    accuracy: attempted === 0 ? 0 : correct / attempted,
    abstained,
    malformed,
    failed,
    thresholds,
    calibration,
    baselineFirstCorrect,
    baselineFirstAccuracy: total === 0 ? 0 : baselineFirstCorrect / total,
    baselineNearestDenominator,
    baselineNearestCorrect,
    baselineNearestAccuracy: baselineNearestDenominator === 0 ? 0 : baselineNearestCorrect / baselineNearestDenominator,
    distinctSessions: perSession.size,
    topSessionConcentration: sessions.sort((a, b) => b.cases - a.cases || a.sessionId.localeCompare(b.sessionId)).slice(0, 5),
    latencyMs,
  };
}

export type OccurrenceVerdict = "promote" | "reject" | "shadow-only";

export const OCCURRENCE_PROMOTION_GATE = Object.freeze({
  minCoverage: 0.95,
  minSelections: 30,
  threshold: 0.9,
  maxWrong: 0,
});

/**
 * Promotion requires candidate-set coverage >= 0.95, Jev beating both
 * deterministic baselines, and >= 30 selections at the chosen threshold with
 * zero wrong. Conditional accuracy alone never promotes.
 */
export function decideOccurrences(coverage: number, metrics: OccurrenceMetrics, labelableCases: number): { verdict: OccurrenceVerdict; reason: string } {
  if (labelableCases < 30) return { verdict: "reject", reason: `insufficient-labelable-cases: ${labelableCases} < 30` };
  if (coverage < OCCURRENCE_PROMOTION_GATE.minCoverage) return { verdict: "reject", reason: `candidate-set coverage ${coverage.toFixed(3)} < ${OCCURRENCE_PROMOTION_GATE.minCoverage}` };
  const atThreshold = metrics.thresholds.find((entry) => entry.threshold === OCCURRENCE_PROMOTION_GATE.threshold)!;
  if (atThreshold.correct < OCCURRENCE_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `correct selections at ${OCCURRENCE_PROMOTION_GATE.threshold}: ${atThreshold.correct} < ${OCCURRENCE_PROMOTION_GATE.minSelections}` };
  if (atThreshold.selections - atThreshold.correct > OCCURRENCE_PROMOTION_GATE.maxWrong) return { verdict: "reject", reason: `wrong selections at ${OCCURRENCE_PROMOTION_GATE.threshold}: ${atThreshold.selections - atThreshold.correct}` };
  const beatsFirst = atThreshold.precision > metrics.baselineFirstAccuracy;
  const beatsNearest = metrics.baselineNearestDenominator === 0 || atThreshold.precision > metrics.baselineNearestAccuracy;
  if (!beatsFirst || !beatsNearest) return { verdict: "shadow-only", reason: `precision ${atThreshold.precision.toFixed(3)} does not beat baselines (first ${metrics.baselineFirstAccuracy.toFixed(3)}, nearest ${metrics.baselineNearestAccuracy.toFixed(3)})` };
  return { verdict: "promote", reason: `coverage ${coverage.toFixed(3)}, precision ${atThreshold.precision.toFixed(3)} at ${atThreshold.selections} selections beating baselines` };
}
