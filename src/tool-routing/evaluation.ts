/**
 * TASK-0033 — jeq evaluation for wrong-tool routing.
 *
 * Requests carry only the attempted tool, its argument keys/types, declared
 * keys from the failure, candidate tool IDs, and the failure class. Never
 * argument values, paths, commands, source, credentials, conversation, or
 * future behavior. A unique schema match stays deterministic: Jev cannot
 * authorize capability escalation.
 */

import { capabilityOf, isRoutingAllowed, type Capability } from "./contracts.ts";
import { deterministicChoice, primaryCandidates, type MatchKind, type ToolMatch } from "./match.ts";
import type { RoutingEpisode } from "./episode.ts";

export const ROUTING_THRESHOLDS = [0.9, 0.99] as const;
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export interface RoutingRequestState {
  failedTool: string;
  failureClass: "schema-validation";
  argKeys: { key: string; type: string }[];
  declaredKeys: string[];
  candidateTools: string[];
}

export const ROUTING_INSTRUCTIONS =
  "A tool call failed schema validation. Based ONLY on the argument keys/types and the closed candidate tools, choose the tool the agent most likely intended, " +
  "or none when the evidence is insufficient. Choose only from the listed criteria.";

export interface RoutingRequest {
  model: string;
  state: RoutingRequestState;
  questions: { tool: { type: "choice"; instructions: string; criteria: Record<string, string> } };
}

export function routingOptions(candidateTools: readonly string[], allowAbstention = true): string[] {
  return allowAbstention ? [...candidateTools, "none"] : [...candidateTools];
}

export function buildRoutingRequest(episode: RoutingEpisode, model = "jev-latest", allowAbstention = true): RoutingRequest {
  const candidates = primaryCandidates(episode.matches).map((match) => match.tool);
  const criteria: Record<string, string> = {};
  for (const tool of candidates) {
    const capability = capabilityOf(tool);
    criteria[tool] = `${tool} (${capability}, routing ${isRoutingAllowed(episode.sourceTool, capability as Capability) ? "allowed" : "blocked"})`;
  }
  if (allowAbstention) criteria.none = "No candidate is sufficiently supported.";
  return {
    model,
    state: {
      failedTool: episode.sourceTool,
      failureClass: "schema-validation",
      argKeys: Object.entries(episode.shape).map(([key, type]) => ({ key, type })),
      declaredKeys: episode.declaredKeys,
      candidateTools: candidates,
    },
    questions: { tool: { type: "choice", instructions: ROUTING_INSTRUCTIONS, criteria } },
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const MODEL_TOKEN = /^[A-Za-z][A-Za-z0-9._-]{0,40}$/;
const SHAPE_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

/**
 * Structural privacy proof for routing requests: the JSON may contain only the
 * closed fields, identifier-shaped keys/types, candidate tool IDs, and bounded
 * criterion descriptions. Any free-form value fails the gate.
 */
export function routingRequestPrivacyPasses(requests: readonly string[]): boolean {
  return requests.every((request) => {
    let parsed: any;
    try { parsed = JSON.parse(request); } catch { return false; }
    if (!parsed || typeof parsed !== "object") return false;
    if (Object.keys(parsed).sort().join(",") !== "model,questions,state") return false;
    if (typeof parsed.model !== "string" || !MODEL_TOKEN.test(parsed.model)) return false;

    const state = parsed.state;
    if (!state || typeof state !== "object") return false;
    if (Object.keys(state).sort().join(",") !== "argKeys,candidateTools,declaredKeys,failedTool,failureClass") return false;
    if (state.failureClass !== "schema-validation") return false;
    if (typeof state.failedTool !== "string" || !IDENTIFIER.test(state.failedTool)) return false;
    if (!Array.isArray(state.argKeys)) return false;
    for (const entry of state.argKeys) {
      if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "key,type") return false;
      if (typeof entry.key !== "string" || !IDENTIFIER.test(entry.key)) return false;
      if (typeof entry.type !== "string" || !SHAPE_TYPES.has(entry.type)) return false;
    }
    for (const list of [state.declaredKeys, state.candidateTools]) {
      if (!Array.isArray(list) || list.some((value: unknown) => typeof value !== "string" || !IDENTIFIER.test(value))) return false;
    }

    const question = parsed.questions?.tool;
    if (!question || question.type !== "choice") return false;
    const criteria = question.criteria;
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return false;
    const expected = [...state.candidateTools, "none"].sort();
    if (Object.keys(criteria).sort().join(",") !== expected.join(",")) return false;
    return Object.values(criteria).every((value) => typeof value === "string" && value.length <= 200);
  });
}

export interface RoutingResponse {
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

export function parseRoutingResponse(raw: string, options: readonly string[], sumTolerance = PROBABILITY_SUM_TOLERANCE): RoutingResponse | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const answer = (parsed as any).answers?.tool;
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

export interface RoutingThresholdMetrics { threshold: number; selections: number; correct: number; precision: number; coverage: number }
export interface RoutingCalibrationBucket { id: string; min: number; max?: number; attempts: number; correct: number; accuracy: number }

export interface RoutingOutcome {
  caseId: string;
  sessionId: string;
  kind: MatchKind;
  /** Candidate set the model chose from. */
  candidates: string[];
  expectedTool: string;
  status: "answered" | "abstained" | "malformed" | "failed";
  choice?: string;
  confidence?: number;
  escalationBlocked?: boolean;
}

export interface RoutingMetrics {
  labelable: number;
  byKind: Record<MatchKind, number>;
  attempted: number;
  correct: number;
  accuracy: number;
  abstained: number;
  malformed: number;
  failed: number;
  thresholds: RoutingThresholdMetrics[];
  calibration: RoutingCalibrationBucket[];
  /** Deterministic baseline: unique-exact match or ranked top-1 over candidates. */
  deterministicDenominator: number;
  deterministicCorrect: number;
  deterministicAccuracy: number;
  escalationBlockedChoices: number;
  distinctSessions: number;
  topSessionConcentration: { sessionId: string; cases: number }[];
}

const BUCKETS: readonly { id: string; min: number; max?: number }[] = [
  { id: "<0.50", min: 0, max: 0.5 },
  { id: "0.50-0.89", min: 0.5, max: 0.9 },
  { id: "0.90-0.98", min: 0.9, max: 0.99 },
  { id: ">=0.99", min: 0.99 },
];

function matchesOf(episode: RoutingEpisode): ToolMatch[] {
  return episode.matches;
}

export function evaluateRouting(
  labelable: readonly RoutingEpisode[],
  results: readonly RoutingOutcome[],
  deterministicChoices: ReadonlyMap<string, string | undefined>,
): RoutingMetrics {
  const byCase = new Map(results.map((result) => [result.caseId, result]));
  const calibration = BUCKETS.map((bucket) => ({ ...bucket, attempts: 0, correct: 0, accuracy: 0 }));
  const thresholds = ROUTING_THRESHOLDS.map((threshold) => ({ threshold, selections: 0, correct: 0, precision: 0, coverage: 0 }));
  const byKind: Record<MatchKind, number> = { "unique-exact": 0, "unique-incomplete": 0, ambiguous: 0, none: 0 };
  const perSession = new Map<string, number>();
  let attempted = 0;
  let correct = 0;
  let abstained = 0;
  let malformed = 0;
  let failed = 0;
  let deterministicDenominator = 0;
  let deterministicCorrect = 0;
  let escalationBlockedChoices = 0;

  for (const episode of labelable) {
    byKind[episode.kind]++;
    perSession.set(episode.sessionId, (perSession.get(episode.sessionId) ?? 0) + 1);

    const deterministic = deterministicChoices.get(episode.episodeId);
    if (deterministic !== undefined && episode.kind !== "none") {
      deterministicDenominator++;
      if (deterministic === episode.labelTool) deterministicCorrect++;
    }

    const result = byCase.get(episode.episodeId);
    if (!result) continue;
    if (result.choice !== undefined && result.choice !== "none") {
      const candidate = matchesOf(episode).find((match) => match.tool === result.choice);
      if (candidate !== undefined && !isRoutingAllowed(episode.sourceTool, candidate.capability)) escalationBlockedChoices++;
    }
    if (result.status === "abstained" || result.choice === "none") { abstained++; continue; }
    if (result.status === "malformed") { malformed++; continue; }
    if (result.status === "failed") { failed++; continue; }
    if (result.choice === undefined) { abstained++; continue; }

    attempted++;
    const isCorrect = result.choice === episode.labelTool;
    if (isCorrect) correct++;
    const confidence = result.confidence ?? 0;
    const bucket = calibration.find((entry) => confidence >= entry.min && (entry.max === undefined || confidence < entry.max));
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
    byKind,
    attempted,
    correct,
    accuracy: attempted === 0 ? 0 : correct / attempted,
    abstained,
    malformed,
    failed,
    thresholds,
    calibration,
    deterministicDenominator,
    deterministicCorrect,
    deterministicAccuracy: deterministicDenominator === 0 ? 0 : deterministicCorrect / deterministicDenominator,
    escalationBlockedChoices,
    distinctSessions: perSession.size,
    topSessionConcentration: sessions.sort((a, b) => b.cases - a.cases || a.sessionId.localeCompare(b.sessionId)).slice(0, 5),
  };
}

/** Deterministic per-episode baseline: unique-exact match or ranked top-1. */
export function deterministicChoiceFor(episode: RoutingEpisode): string | undefined {
  return deterministicChoice(episode.matches);
}

export type RoutingVerdict = "promote" | "reject" | "shadow-only";

export const ROUTING_PROMOTION_GATE = Object.freeze({
  minSelections: 30,
  threshold: 0.9,
  maxWrong: 0,
});

/**
 * Promotion requires at least 30 correct selections at the chosen threshold,
 * zero wrong selections, a positive margin over the deterministic baseline,
 * and no blocked capability escalation among selected answers.
 */
export function decideRouting(metrics: RoutingMetrics): { verdict: RoutingVerdict; reason: string } {
  const atThreshold = metrics.thresholds.find((entry) => entry.threshold === ROUTING_PROMOTION_GATE.threshold)!;
  if (metrics.escalationBlockedChoices > 0) return { verdict: "reject", reason: `blocked capability escalation chosen ${metrics.escalationBlockedChoices} time(s)` };
  if (atThreshold.correct < ROUTING_PROMOTION_GATE.minSelections) return { verdict: "reject", reason: `correct selections at ${ROUTING_PROMOTION_GATE.threshold}: ${atThreshold.correct} < ${ROUTING_PROMOTION_GATE.minSelections}` };
  if (atThreshold.selections - atThreshold.correct > ROUTING_PROMOTION_GATE.maxWrong) return { verdict: "reject", reason: `wrong selections at ${ROUTING_PROMOTION_GATE.threshold}: ${atThreshold.selections - atThreshold.correct}` };
  if (atThreshold.precision <= metrics.deterministicAccuracy) return { verdict: "shadow-only", reason: `precision ${atThreshold.precision.toFixed(3)} does not beat deterministic baseline ${metrics.deterministicAccuracy.toFixed(3)}` };
  return { verdict: "promote", reason: `precision ${atThreshold.precision.toFixed(3)} at ${atThreshold.selections} selections beating deterministic baseline ${metrics.deterministicAccuracy.toFixed(3)}` };
}
