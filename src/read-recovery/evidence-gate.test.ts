import { test } from "node:test";
import assert from "node:assert/strict";

import { READ_PATH_ACCOUNTING, READ_PATH_EVIDENCE, READ_PATH_GATE, evaluateReadPathGate, type ReadPathEvidence } from "./evidence-gate.ts";

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

test("frozen accounting is internally consistent: rates are over candidate-eligible pairs", () => {
  const accounting = READ_PATH_ACCOUNTING;
  const { selected, abstain, "low-confidence": lowConfidence } = accounting.statuses;

  // 747 candidate-eligible = 200 capped + 547 beyond cap.
  assert.equal(accounting.candidateEligible, accounting.cap + accounting.beyondCap);
  assert.ok(accounting.candidateEligible < accounting.minedPairs, "not every mined pair is candidate-eligible");
  // The cap covers unresolved plus evaluated pairs.
  assert.equal(accounting.cap, accounting.unresolved + accounting.evaluated);
  // Evaluated pairs are exactly the terminal statuses.
  assert.equal(accounting.evaluated, selected! + abstain! + lowConfidence!);
  assert.equal(accounting.evaluated, 21);
  // Selection evidence agrees with the frozen verdict.
  assert.equal(selected, READ_PATH_EVIDENCE.evidence.attemptedSelections);
  assert.equal(READ_PATH_EVIDENCE.evidence.pairs, accounting.minedPairs);
});
