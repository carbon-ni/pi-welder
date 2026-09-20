/**
 * TASK-0021 — routing action policy, deterministic baseline, and metrics.
 *
 * Order: deterministic routing first; Jev sees only cases the deterministic
 * router leaves unresolved. Jev answers are bounded to existing rule IDs or
 * "none"; unknown output fails closed. A wrong selection of a mutating rule is
 * a hard safety failure.
 */

import { REPAIR_ACTIONS, type RepairAction } from "../repairs/types.ts";
import type { RoutingState } from "./sanitize.ts";
import type { LabeledFailure, RoutingLabel } from "./dataset.ts";

export type RoutingAnswer = RepairAction | "none";

export const ROUTING_POLICY = Object.freeze({
  minLabeledUnresolved: 30,
  confidenceThreshold: 0.99,
  minPrecision: 0.99,
  maxUnsafeWrong: 0,
});

/** Rules that rewrite tool arguments or block a call: a wrong pick is unsafe. */
export const UNSAFE_RULES: ReadonlySet<string> = new Set<string>([
  "strip-null", "strip-null-like", "clean-path", "parse-json", "wrap-array", "wrap-object-array",
  "split-string", "coerce-boolean", "coerce-number", "strip-extra-props", "rename-edit-item-alias",
  "drop-noop-edit", "rename-aliased-field", "relational-default", "nest-edit-fields", "merge-edit-anchor",
  "resolve-ambiguous-edit", "restore-read-shape", "restore-read-path",
]);

/**
 * Deterministic keyword baseline. Frozen and cheap; it must not consult the
 * dataset labels. Returns a rule ID or "none" when it routes, undefined when
 * the case remains unresolved for Jev.
 */
export function deterministicRoute(state: RoutingState): RoutingAnswer | undefined {
  const text = state.errorText.toLowerCase();

  if (/found \d+ occurrences/.test(text)) return "resolve-ambiguous-edit";
  if (text.includes("beyond end of file")) return "read-offset-context";
  if (text.includes("eisdir") || text.includes("illegal operation on a directory")) return "directory-read";
  if (text.includes("replacement produced identical content") || text.includes("no changes made")) return "edit-noop";
  if (state.toolName === "read" && (text.includes("enoent") || text.includes("no such file"))) return "missing-read-context";

  return undefined;
}

/** Parses a jeq Choice criteria key; unknown or abstain fails closed. */
export function parseRouteAnswer(choice: string | null | undefined): RoutingAnswer | undefined {
  if (choice === null || choice === undefined) return undefined;
  if (choice === "none") return "none";
  return (REPAIR_ACTIONS as readonly string[]).includes(choice) ? (choice as RepairAction) : undefined;
}

export interface JevRouteResult {
  caseId: string;
  status: "answered" | "abstain" | "malformed" | "failed";
  answer?: RoutingAnswer;
  confidence?: number;
  latencyMs: number;
}

export interface RoutingMetrics {
  cases: number;
  labeledUnresolved: number;
  deterministicCovered: number;
  deterministicCorrect: number;
  deterministicCoverage: number;
  deterministicPrecision: number;
  jevEligible: number;
  jevAttempted: number;
  jevAbstained: number;
  jevMalformed: number;
  jevFailed: number;
  jevCorrect: number;
  jevWrong: number;
  jevUnsafeWrong: number;
  jevPrecision: number;
  jevHighConfidenceAttempted: number;
  jevPrecisionAtThreshold: number;
  marginalCoverage: number;
  latencyMs: number;
}

/** Computes routing metrics. Jev precision counts only baseline-unresolved cases. */
export function evaluateRouting(
  cases: readonly LabeledFailure[],
  states: ReadonlyMap<string, RoutingState>,
  jevResults: readonly JevRouteResult[],
): RoutingMetrics {
  const jevByCase = new Map(jevResults.map((result) => [result.caseId, result]));
  let deterministicCovered = 0;
  let deterministicCorrect = 0;
  let labeledUnresolved = 0;
  let jevAttempted = 0;
  let jevAbstained = 0;
  let jevMalformed = 0;
  let jevFailed = 0;
  let jevCorrect = 0;
  let jevWrong = 0;
  let jevUnsafeWrong = 0;
  let jevHighConfidenceAttempted = 0;
  let jevHighConfidenceCorrect = 0;
  let latencyMs = 0;

  for (const evaluationCase of cases) {
    const state = states.get(evaluationCase.caseId);
    const baseline = state ? deterministicRoute(state) : undefined;
    if (baseline !== undefined) {
      deterministicCovered++;
      if (baseline === evaluationCase.label) deterministicCorrect++;
      continue; // deterministic coverage is excluded from Jev precision
    }
    labeledUnresolved++;

    const result = jevByCase.get(evaluationCase.caseId);
    if (!result) continue;
    latencyMs += result.latencyMs;
    if (result.status === "abstain") { jevAbstained++; continue; }
    if (result.status === "malformed") { jevMalformed++; continue; }
    if (result.status === "failed") { jevFailed++; continue; }

    const answer = result.answer;
    if (answer === undefined) { jevAbstained++; continue; }
    jevAttempted++;
    const correct = answer === evaluationCase.label;
    if (correct) {
      jevCorrect++;
    } else {
      jevWrong++;
      if (UNSAFE_RULES.has(answer)) jevUnsafeWrong++;
    }
    if ((result.confidence ?? 0) >= ROUTING_POLICY.confidenceThreshold) {
      jevHighConfidenceAttempted++;
      if (correct) jevHighConfidenceCorrect++;
    }
  }

  return {
    cases: cases.length,
    labeledUnresolved,
    deterministicCovered,
    deterministicCorrect,
    deterministicCoverage: cases.length === 0 ? 0 : deterministicCovered / cases.length,
    deterministicPrecision: deterministicCovered === 0 ? 0 : deterministicCorrect / deterministicCovered,
    jevEligible: labeledUnresolved,
    jevAttempted,
    jevAbstained,
    jevMalformed,
    jevFailed,
    jevCorrect,
    jevWrong,
    jevUnsafeWrong,
    jevPrecision: jevAttempted === 0 ? 0 : jevCorrect / jevAttempted,
    jevHighConfidenceAttempted,
    jevPrecisionAtThreshold: jevHighConfidenceAttempted === 0 ? 0 : jevHighConfidenceCorrect / jevHighConfidenceAttempted,
    marginalCoverage: jevCorrect,
    latencyMs,
  };
}

export type RoutingRecommendation = "route" | "don't-route" | "needs-more-data";

export function decideRouting(metrics: RoutingMetrics): { decision: RoutingRecommendation; reason: string } {
  if (metrics.jevUnsafeWrong > ROUTING_POLICY.maxUnsafeWrong) {
    return { decision: "don't-route", reason: `wrong mutating-rule selections: ${metrics.jevUnsafeWrong}` };
  }
  if (metrics.labeledUnresolved < ROUTING_POLICY.minLabeledUnresolved) {
    return { decision: "needs-more-data", reason: `labeled unresolved cases: ${metrics.labeledUnresolved} < ${ROUTING_POLICY.minLabeledUnresolved}` };
  }
  if (metrics.jevPrecisionAtThreshold < ROUTING_POLICY.minPrecision) {
    return { decision: "don't-route", reason: `precision@${ROUTING_POLICY.confidenceThreshold}: ${metrics.jevPrecisionAtThreshold.toFixed(3)} < ${ROUTING_POLICY.minPrecision}` };
  }
  if (metrics.jevHighConfidenceAttempted < ROUTING_POLICY.minLabeledUnresolved) {
    return { decision: "needs-more-data", reason: `high-confidence attempts: ${metrics.jevHighConfidenceAttempted} < ${ROUTING_POLICY.minLabeledUnresolved}` };
  }
  return { decision: "route", reason: `precision@${ROUTING_POLICY.confidenceThreshold} ${metrics.jevPrecisionAtThreshold.toFixed(3)} over ${metrics.jevHighConfidenceAttempted} attempts` };
}

export type { LabeledFailure, RoutingLabel };
