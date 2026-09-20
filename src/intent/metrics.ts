/**
 * TASK-0029 — jeq response parsing (probabilities preserved, fail closed) and
 * evaluation metrics (top-1 accuracy, calibration, uncertain behavior,
 * precision at >= 0.99, per-family breakdown).
 *
 * Scope: labels are a FUTURE-BEHAVIOR PROXY (the next successful call), not
 * verified causal intent. Metrics measure agreement with that proxy.
 */

import type { FailureFamily } from "./context.ts";
import type { IntentLabel } from "./hypotheses.ts";

export interface IntentResponse {
  choice: string;
  confidence?: number;
  /** Per-option probabilities exactly as returned. */
  probabilities: Record<string, number>;
  model?: string;
}

/**
 * Parses a jeq Choice response, preserving the probability distribution.
 *
 * Hardened fail-closed rules: the choice must be one of the family's criteria;
 * `confidence`, when present, must be a finite number in [0,1]; `probabilities`
 * must be present with keys EXACTLY equal to the criteria set, every value a
 * finite number in [0,1], and the values must sum to 1 within tolerance.
 * Anything else returns undefined (malformed).
 */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export function parseIntentResponse(
  raw: string,
  validIds: ReadonlySet<string>,
  options: { sumTolerance?: number } = {},
): IntentResponse | undefined {
  const sumTolerance = options.sumTolerance ?? PROBABILITY_SUM_TOLERANCE;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.hypothesis;
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string") return undefined;
  if (!validIds.has(answer.choice)) return undefined;

  const confidence = answer.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return undefined;
  }

  const rawProbabilities = answer.probabilities;
  if (!rawProbabilities || typeof rawProbabilities !== "object" || Array.isArray(rawProbabilities)) return undefined;
  const probabilityKeys = Object.keys(rawProbabilities as Record<string, unknown>).sort();
  const expectedKeys = [...validIds].sort();
  if (probabilityKeys.length !== expectedKeys.length || probabilityKeys.some((key, index) => key !== expectedKeys[index])) {
    return undefined; // keys must be exactly the criteria choices
  }

  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const key of expectedKeys) {
    const value = (rawProbabilities as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
    probabilities[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > sumTolerance) return undefined;

  const model = typeof (parsed as any).model === "string" ? (parsed as any).model : undefined;
  return { choice: answer.choice, ...(confidence === undefined ? {} : { confidence }), probabilities, ...(model === undefined ? {} : { model }) };
}

export interface IntentResult {
  caseId: string;
  family: FailureFamily;
  label: IntentLabel;
  status: "answered" | "uncertain" | "malformed" | "failed";
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  latencyMs: number;
}

export interface CalibrationBucket {
  id: string;
  min: number;
  max?: number;
  attempts: number;
  correct: number;
  accuracy: number;
}

export interface FamilyMetrics {
  family: FailureFamily;
  cases: number;
  labeled: number;
  attempted: number;
  correct: number;
  accuracy: number;
  uncertain: number;
  highConfidenceAttempted: number;
  highConfidenceCorrect: number;
  precisionAtThreshold: number;
}

export interface IntentMetrics {
  cases: number;
  labeled: number;
  attempted: number;
  correct: number;
  top1Accuracy: number;
  uncertain: number;
  malformed: number;
  failed: number;
  unresolvable: number;
  uncertainRate: number;
  highConfidenceAttempted: number;
  highConfidenceCorrect: number;
  precisionAtThreshold: number;
  calibration: CalibrationBucket[];
  families: FamilyMetrics[];
  latencyMs: number;
}

export const INTENT_THRESHOLD = 0.99;

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.79", min: 0.5, max: 0.8 },
  { id: "0.80-0.98", min: 0.8, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

/** Computes intent metrics; unattempted/uncertain cases never count as correct. */
export function evaluateIntent(results: readonly IntentResult[]): IntentMetrics {
  const families = new Map<FailureFamily, FamilyMetrics>();
  const familyOf = (family: FailureFamily): FamilyMetrics => {
    const existing = families.get(family);
    if (existing) return existing;
    const created: FamilyMetrics = { family, cases: 0, labeled: 0, attempted: 0, correct: 0, accuracy: 0, uncertain: 0, highConfidenceAttempted: 0, highConfidenceCorrect: 0, precisionAtThreshold: 0 };
    families.set(family, created);
    return created;
  };

  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  let attempted = 0;
  let correct = 0;
  let uncertain = 0;
  let malformed = 0;
  let failed = 0;
  let unresolvable = 0;
  let highConfidenceAttempted = 0;
  let highConfidenceCorrect = 0;
  let latencyMs = 0;

  for (const result of results) {
    latencyMs += result.latencyMs;
    const family = familyOf(result.family);
    family.cases++;
    if (result.label !== "unresolvable") family.labeled++;
    else unresolvable++;

    const isAttempted = result.status === "answered" && result.choice !== undefined && result.choice !== "uncertain";
    if (result.status === "uncertain") { uncertain++; family.uncertain++; continue; }
    if (result.status === "malformed") { malformed++; continue; }
    if (result.status === "failed") { failed++; continue; }
    if (!isAttempted) continue;

    attempted++;
    family.attempted++;
    const isCorrect = result.label !== "unresolvable" && result.choice === result.label;
    if (isCorrect) {
      correct++;
      family.correct++;
    }
    const confidence = result.confidence ?? 0;
    const bucket = calibration.find((candidate) => confidence >= candidate.min && (candidate.max === undefined || confidence < candidate.max));
    if (bucket) {
      bucket.attempts++;
      if (isCorrect) bucket.correct++;
    }
    if (confidence >= INTENT_THRESHOLD) {
      highConfidenceAttempted++;
      family.highConfidenceAttempted++;
      if (isCorrect) {
        highConfidenceCorrect++;
        family.highConfidenceCorrect++;
      }
    }
  }

  for (const bucket of calibration) bucket.accuracy = bucket.attempts === 0 ? 0 : bucket.correct / bucket.attempts;
  for (const family of families.values()) {
    family.accuracy = family.attempted === 0 ? 0 : family.correct / family.attempted;
    family.precisionAtThreshold = family.highConfidenceAttempted === 0 ? 0 : family.highConfidenceCorrect / family.highConfidenceAttempted;
  }

  const labeled = results.filter((result) => result.label !== "unresolvable").length;
  return {
    cases: results.length,
    labeled,
    attempted,
    correct,
    top1Accuracy: attempted === 0 ? 0 : correct / attempted,
    uncertain,
    malformed,
    failed,
    unresolvable,
    uncertainRate: results.length === 0 ? 0 : uncertain / results.length,
    highConfidenceAttempted,
    highConfidenceCorrect,
    precisionAtThreshold: highConfidenceAttempted === 0 ? 0 : highConfidenceCorrect / highConfidenceAttempted,
    calibration,
    families: [...families.values()].sort((a, b) => a.family.localeCompare(b.family)),
    latencyMs,
  };
}
