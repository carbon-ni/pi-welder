/**
 * TASK-0035 — Jev judge for non-exact command mappings (evaluation + metrics).
 *
 * Requests carry safe key tokens, closed derived features, candidate ordinals,
 * the attempted tool, and bounded prior intent signals. Raw values, paths,
 * commands, source, credentials, conversation, and future behavior never leave
 * the machine.
 */

import { MAX_CANDIDATES, mappingOptions, type CommandCandidate } from "./candidates.ts";

export const MAPPING_THRESHOLDS = [0.9, 0.99] as const;
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export interface MappingRequestCandidate {
  ordinal: number;
  key: string;
  shape: string;
  lengthBucket: string;
  tokenBucket: string;
  lineBucket: string;
  executableLike: boolean;
  shellOperator: boolean;
  redirection: boolean;
  assignment: boolean;
  pathLike: boolean;
  proseLike: boolean;
}

export interface MappingPriorSignals {
  /** Bounded closed signals from up to three prior events. */
  priorToolNames: string[];
  priorFailedCalls: number;
  priorUserMessages: number;
}

export interface MappingRequestState {
  failedTool: string;
  failureClass: "schema-validation";
  canonicalTimeout: boolean;
  candidates: MappingRequestCandidate[];
  prior: MappingPriorSignals;
}

export const MAPPING_INSTRUCTIONS =
  "A tool call failed schema validation. Exactly one of its string fields may have been intended as bash's `command`. " +
  "Based ONLY on the closed features, choose the candidate ordinal that best explains the intent, or none. Choose only from the listed criteria.";

export interface MappingRequest {
  model: string;
  state: MappingRequestState;
  questions: { mapping: { type: "choice"; instructions: string; criteria: Record<string, string> } };
}

export function candidateFeatures(candidate: CommandCandidate): MappingRequestCandidate {
  return {
    ordinal: candidate.ordinal,
    key: candidate.key,
    shape: candidate.shape,
    lengthBucket: candidate.lengthBucket,
    tokenBucket: candidate.tokenBucket,
    lineBucket: candidate.lineBucket,
    executableLike: candidate.executableLike,
    shellOperator: candidate.shellOperator,
    redirection: candidate.redirection,
    assignment: candidate.assignment,
    pathLike: candidate.pathLike,
    proseLike: candidate.proseLike,
  };
}

export const EMPTY_PRIOR: MappingPriorSignals = { priorToolNames: [], priorFailedCalls: 0, priorUserMessages: 0 };

export function buildMappingRequest(
  failedTool: string,
  candidates: readonly CommandCandidate[],
  options: { canonicalTimeout?: boolean; prior?: MappingPriorSignals; model?: string } = {},
): MappingRequest {
  const prior = options.prior ?? EMPTY_PRIOR;
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[`candidate-${candidate.ordinal}`] = `Field "${candidate.key}" (${candidate.shape}, ${candidate.lengthBucket} length, ${candidate.tokenBucket} tokens)`;
  }
  criteria.none = "No candidate is sufficiently supported.";
  return {
    model: options.model ?? "jev-latest",
    state: {
      failedTool,
      failureClass: "schema-validation",
      canonicalTimeout: options.canonicalTimeout === true,
      candidates: candidates.map(candidateFeatures),
      prior: {
        priorToolNames: prior.priorToolNames.slice(0, 3),
        priorFailedCalls: prior.priorFailedCalls,
        priorUserMessages: prior.priorUserMessages,
      },
    },
    questions: { mapping: { type: "choice", instructions: MAPPING_INSTRUCTIONS, criteria } },
  };
}

export interface MappingResponse {
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

/** Hardened Choice parsing: closed options, finite probabilities, keys and sum. */
export function parseMappingResponse(raw: string, options: readonly string[], sumTolerance = PROBABILITY_SUM_TOLERANCE): MappingResponse | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.mapping;
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

export interface MappingThresholdMetrics { threshold: number; selections: number; correct: number; precision: number; coverage: number }
export interface MappingCalibrationBucket { id: string; min: number; max?: number; attempts: number; correct: number; accuracy: number }

export interface MappingOutcome {
  caseId: string;
  sessionId: string;
  status: "answered" | "abstained" | "malformed" | "failed";
  choice?: string;
  confidence?: number;
  latencyMs: number;
}

export interface LabelledMappingCase {
  caseId: string;
  sessionId: string;
  labelOrdinal: number;
  /** Deterministic alias baseline ordinal (canonical/alias name first). */
  baselineAlias?: number;
  /** First enumerated candidate by key order. */
  baselineFirst?: number;
}

export interface MappingMetrics {
  labelable: number;
  attempted: number;
  correct: number;
  accuracy: number;
  abstained: number;
  malformed: number;
  failed: number;
  candidatesMean: number;
  thresholds: MappingThresholdMetrics[];
  calibration: MappingCalibrationBucket[];
  baselineAliasCorrect: number;
  baselineAliasAccuracy: number;
  baselineFirstAccuracy: number;
  distinctSessions: number;
  topSessionConcentration: { sessionId: string; cases: number }[];
}

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.89", min: 0.5, max: 0.9 },
  { id: "0.90-0.98", min: 0.9, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

export function evaluateMappings(labelable: readonly LabelledMappingCase[], results: readonly MappingOutcome[]): MappingMetrics {
  const byCase = new Map(results.map((result) => [result.caseId, result]));
  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  const thresholds = MAPPING_THRESHOLDS.map((threshold) => ({ threshold, selections: 0, correct: 0, precision: 0, coverage: 0 }));
  const perSession = new Map<string, number>();
  let attempted = 0;
  let correct = 0;
  let abstained = 0;
  let malformed = 0;
  let failed = 0;
  let baselineAliasCorrect = 0;
  let baselineAliasDenominator = 0;
  let baselineFirstCorrect = 0;

  for (const entry of labelable) {
    perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1);
    if (entry.baselineAlias !== undefined) {
      baselineAliasDenominator++;
      if (entry.baselineAlias === entry.labelOrdinal) baselineAliasCorrect++;
    }
    if (entry.baselineFirst !== undefined && entry.baselineFirst === entry.labelOrdinal) baselineFirstCorrect++;

    const result = byCase.get(entry.caseId);
    if (!result || result.status === "abstained" || result.choice === undefined || result.choice === "none") { abstained++; continue; }
    if (result.status === "malformed") { malformed++; continue; }
    if (result.status === "failed") { failed++; continue; }

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

  const sessions = [...perSession.entries()].map(([sessionId, cases]) => ({ sessionId, cases }));
  return {
    labelable: labelable.length,
    attempted,
    correct,
    accuracy: attempted === 0 ? 0 : correct / attempted,
    abstained,
    malformed,
    failed,
    candidatesMean: 0,
    thresholds,
    calibration,
    baselineAliasCorrect,
    baselineAliasAccuracy: baselineAliasDenominator === 0 ? 0 : baselineAliasCorrect / baselineAliasDenominator,
    baselineFirstAccuracy: labelable.length === 0 ? 0 : baselineFirstCorrect / labelable.length,
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

/**
 * Promotion requires candidate-set coverage >= 0.95, >= 30 selections at the
 * chosen threshold with zero wrong, and a positive margin over both
 * deterministic baselines. Jev never authorizes execution by itself.
 */
export function decideMapping(coverage: number, metrics: MappingMetrics, labelableCases: number): { verdict: MappingVerdict; reason: string } {
  if (labelableCases < MAPPING_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `insufficient-labelable-cases: ${labelableCases} < ${MAPPING_PROMOTION_GATE.minSelections}` };
  if (coverage < MAPPING_PROMOTION_GATE.minCoverage) return { verdict: "reject", reason: `candidate-set coverage ${coverage.toFixed(3)} < ${MAPPING_PROMOTION_GATE.minCoverage}` };
  const atThreshold = metrics.thresholds.find((entry) => entry.threshold === MAPPING_PROMOTION_GATE.threshold)!;
  if (atThreshold.correct < MAPPING_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `correct selections at ${MAPPING_PROMOTION_GATE.threshold}: ${atThreshold.correct} < ${MAPPING_PROMOTION_GATE.minSelections}` };
  if (atThreshold.selections - atThreshold.correct > MAPPING_PROMOTION_GATE.maxWrong) return { verdict: "reject", reason: `wrong selections at ${MAPPING_PROMOTION_GATE.threshold}: ${atThreshold.selections - atThreshold.correct}` };
  if (atThreshold.precision <= metrics.baselineAliasAccuracy || atThreshold.precision <= metrics.baselineFirstAccuracy) {
    return { verdict: "shadow-only", reason: `precision ${atThreshold.precision.toFixed(3)} does not beat baselines (alias ${metrics.baselineAliasAccuracy.toFixed(3)}, first ${metrics.baselineFirstAccuracy.toFixed(3)})` };
  }
  return { verdict: "promote", reason: `coverage ${coverage.toFixed(3)}, precision ${atThreshold.precision.toFixed(3)} at ${atThreshold.selections} selections beating both baselines` };
}

export { MAX_CANDIDATES, mappingOptions };
