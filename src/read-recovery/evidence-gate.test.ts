import { test } from "node:test";
import assert from "node:assert/strict";

import { READ_PATH_EVIDENCE, READ_PATH_GATE, evaluateReadPathGate, type ReadPathEvidence } from "./evidence-gate.ts";

function evidence(overrides: Partial<ReadPathEvidence> = {}): ReadPathEvidence {
  return { pairs: 100, reviewedLabels: 40, attemptedSelections: 40, correct: 40, wrongTargets: 0, precision: 1, ...overrides };
}

test("the predeclared gate is fixed", () => {
  assert.deepEqual(READ_PATH_GATE, { minReviewedLabels: 30, confidenceThreshold: 0.9, minPrecision: 0.99, maxWrongTargets: 0 });
});

test("any wrong-target fails the gate regardless of precision", () => {
  const verdict = evaluateReadPathGate(evidence({ wrongTargets: 1, correct: 39, attemptedSelections: 60, precision: 39 / 60 }));
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /wrong-target/);
});

test("the gate requires at least 30 reviewed labels and precision >= 0.99", () => {
  assert.equal(evaluateReadPathGate(evidence({ reviewedLabels: 29 })).passed, false);
  assert.match(evaluateReadPathGate(evidence({ reviewedLabels: 29 })).reason, /insufficient-reviewed/);
  assert.equal(evaluateReadPathGate(evidence({ correct: 98, attemptedSelections: 100, precision: 0.98 })).passed, false);
  assert.equal(evaluateReadPathGate(evidence()).passed, true);
});

test("the frozen verdict reflects the failed offline evaluation and blocks mutation", () => {
  assert.equal(READ_PATH_EVIDENCE.passed, false);
  assert.equal(READ_PATH_EVIDENCE.evidence.wrongTargets, 2);
  assert.equal(READ_PATH_EVIDENCE.evidence.reviewedLabels, 0);
  assert.match(READ_PATH_EVIDENCE.reason, /wrong-target/);
});
