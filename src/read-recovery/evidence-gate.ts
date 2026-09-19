/**
 * TASK-0022 — predeclared evidence gate for read-path auto-repair.
 *
 * Auto-mutation may run ONLY when this gate passes. The gate is fixed before
 * evaluation: at least 30 reviewed labels, precision >= 0.99 at the 0.9
 * confidence threshold, and zero wrong-target selections. The frozen verdict
 * below is the committed outcome of the offline evaluation.
 */

export const READ_PATH_GATE = Object.freeze({
  minReviewedLabels: 30,
  confidenceThreshold: 0.9,
  minPrecision: 0.99,
  maxWrongTargets: 0,
});

export interface ReadPathEvidence {
  pairs: number;
  /** Human-reviewed labels only; provisional/offline matches do not count. */
  reviewedLabels: number;
  attemptedSelections: number;
  correct: number;
  wrongTargets: number;
  precision: number | undefined;
}

export interface ReadPathVerdict {
  passed: boolean;
  reason: string;
  evidence: ReadPathEvidence;
}

/** Predeclared decision rule — do not tune after seeing results. */
export function evaluateReadPathGate(evidence: ReadPathEvidence): ReadPathVerdict {
  if (evidence.wrongTargets > READ_PATH_GATE.maxWrongTargets) {
    return { passed: false, reason: `wrong-target selections: ${evidence.wrongTargets} > ${READ_PATH_GATE.maxWrongTargets}`, evidence };
  }
  if (evidence.reviewedLabels < READ_PATH_GATE.minReviewedLabels) {
    return { passed: false, reason: `insufficient-reviewed-labels: ${evidence.reviewedLabels} < ${READ_PATH_GATE.minReviewedLabels}`, evidence };
  }
  if ((evidence.precision ?? 0) < READ_PATH_GATE.minPrecision) {
    return { passed: false, reason: `precision ${evidence.precision?.toFixed(3)} < ${READ_PATH_GATE.minPrecision}`, evidence };
  }
  return { passed: true, reason: `precision ${evidence.precision?.toFixed(3)} at ${evidence.reviewedLabels} reviewed labels`, evidence };
}

/**
 * Frozen offline-evaluation outcome (TASK-0022, real corpus, 2026-09-19).
 *
 * See `.tmp/reports/19-09-26/task-0022-read-path-repair.md`. Deterministic
 * candidate generation reached top-1 8.6% / top-5 14.5% on 1411 mined pairs;
 * the bounded Jev probe produced 7 attempted selections with 2 wrong-target
 * selections and zero human-reviewed labels. The gate therefore FAILS and
 * runtime auto-mutation stays disabled; only shadow-only eligibility
 * instrumentation runs.
 */
export const READ_PATH_EVIDENCE: ReadPathVerdict = evaluateReadPathGate({
  pairs: 1411,
  reviewedLabels: 0,
  attemptedSelections: 7,
  correct: 5,
  wrongTargets: 2,
  precision: 5 / 7,
});
