import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PRIOR_TOOLS,
  argShapeOf,
  boundPriorTools,
  buildIntentState,
  classifyFailureFamily,
  failureClassOf,
  valueShape,
  type IntentContext,
  type PriorToolObservation,
} from "./context.ts";
import {
  UNCERTAIN_HYPOTHESIS,
  hypothesisCriteria,
  hypothesesFor,
  labelFor,
  labelInvalidShape,
  validIntentIds,
} from "./hypotheses.ts";
import { INTENT_THRESHOLD, evaluateIntent, parseIntentResponse, type IntentResult } from "./metrics.ts";

const FAMILIES = ["missing-read", "ambiguous-edit", "edit-mismatch", "invalid-shape"] as const;

test("hypotheses are causal intent claims, 2-4 per family plus uncertain, with no rule/policy ids", () => {
  for (const family of FAMILIES) {
    const hypotheses = hypothesesFor(family);
    assert.ok(hypotheses.length >= 2 && hypotheses.length <= 4, family);
    const ids = new Set(hypotheses.map((hypothesis) => hypothesis.id));
    assert.equal(ids.size, hypotheses.length, "mutually exclusive ids");
    for (const hypothesis of hypotheses) {
      assert.ok(hypothesis.id.startsWith("intent."), hypothesis.id);
      assert.doesNotMatch(hypothesis.id, /-edit$|noop|read-offset|directory-read|restore-|none/);
      assert.match(hypothesis.claim, /\bintended\b/, hypothesis.claim);
    }
    const criteria = hypothesisCriteria(family);
    assert.deepEqual(new Set(Object.keys(criteria)), validIntentIds(family));
    assert.equal(criteria[UNCERTAIN_HYPOTHESIS.id], UNCERTAIN_HYPOTHESIS.claim);
  }
});

test("ground truth labels come from the later success and stay deterministic", () => {
  assert.equal(labelFor("missing-read", { toolName: "read" }), "intent.read-existing-file");
  assert.equal(labelFor("missing-read", { toolName: "write" }), "intent.create-then-read");
  assert.equal(labelFor("missing-read", { toolName: "bash" }), "intent.inspect-location");
  assert.equal(labelFor("ambiguous-edit", { toolName: "edit", extendsFailedLocator: true }), "intent.one-occurrence-needs-context");
  assert.equal(labelFor("ambiguous-edit", { toolName: "edit", extendsFailedLocator: false }), "intent.different-occurrence");
  assert.equal(labelFor("edit-mismatch", { toolName: "read" }), "intent.inspect-before-editing");
  assert.equal(labelInvalidShape("edit", { toolName: "edit" }), "intent.same-operation-corrected");
  assert.equal(labelInvalidShape("edit", { toolName: "read", sameTarget: true }), "intent.different-operation");
  assert.equal(labelInvalidShape("edit", { toolName: "bash" }), "intent.unrelated-continuation");
  assert.equal(labelFor("invalid-shape", { toolName: "read" }), "unresolvable");
});

test("failure-family classification is closed and deterministic", () => {
  assert.equal(classifyFailureFamily("read", "ENOENT: no such file", { path: "x" }), "missing-read");
  assert.equal(classifyFailureFamily("edit", "Found 2 occurrences of the text", { edits: [] }), "ambiguous-edit");
  assert.equal(classifyFailureFamily("edit", "Could not find edits[0]", { edits: [] }), "edit-mismatch");
  assert.equal(classifyFailureFamily("edit", "Missing required field: edits", { path: "x" }), "invalid-shape");
  assert.equal(classifyFailureFamily("bash", "Command exited with code 1", { command: "x" }), undefined);
  assert.equal(failureClassOf("missing-read", "read"), "read.path-missing");
  assert.equal(failureClassOf("invalid-shape", "edit"), "edit.shape-invalid");
});

test("structural context carries key names and value types only, never values", () => {
  assert.equal(valueShape([1, 2]), "array");
  assert.equal(valueShape({ a: 1 }), "object");
  assert.equal(valueShape("secret"), "string");
  const { argKeys, argTypes } = argShapeOf({ path: "/Users/example/secret.ts", edits: [{ oldText: "x" }], offset: 5 });
  assert.deepEqual(argKeys, ["edits", "offset", "path"]);
  assert.deepEqual(argTypes, { edits: "array", offset: "number", path: "string" });

  const context: IntentContext = {
    family: "missing-read",
    attemptedTool: "read",
    argKeys,
    argTypes,
    failureClass: "read.path-missing",
    priorTools: [{ name: "read", outcome: "error" }, { name: "write", outcome: "ok" }],
  };
  const state = buildIntentState(context);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /Users|secret|oldText|\//, "no values, paths, or content");
  assert.deepEqual(Object.keys(state).sort(), ["argKeys", "argTypes", "attemptedTool", "failureClass", "family", "priorTools"]);
});

test("prior-tool history is bounded to the most recent observations", () => {
  const prior: PriorToolObservation[] = Array.from({ length: 10 }, (_, index) => ({ name: `tool-${index}`, outcome: index % 2 ? "error" : "ok" }));
  const bounded = boundPriorTools(prior);
  assert.equal(bounded.length, MAX_PRIOR_TOOLS);
  assert.deepEqual(bounded.map((entry) => entry.name), ["tool-6", "tool-7", "tool-8", "tool-9"]);
});

test("jeq parsing preserves probabilities, validates options, and fails closed", () => {
  const valid = validIntentIds("missing-read");
  const raw = JSON.stringify({
    model: "jev-1.13.0",
    answers: { hypothesis: { type: "choice", choice: "intent.create-then-read", confidence: 0.82, probabilities: { "intent.create-then-read": 0.82, "intent.read-existing-file": 0.1, uncertain: 0.08 } } },
  });
  const parsed = parseIntentResponse(raw, valid)!;
  assert.equal(parsed.choice, "intent.create-then-read");
  assert.equal(parsed.confidence, 0.82);
  assert.deepEqual(parsed.probabilities, { "intent.create-then-read": 0.82, "intent.read-existing-file": 0.1, uncertain: 0.08 });
  assert.equal(parsed.model, "jev-1.13.0");

  assert.equal(parseIntentResponse(raw, validIntentIds("ambiguous-edit")), undefined, "choice invalid for family fails closed");
  assert.equal(parseIntentResponse("not json", valid), undefined);
  assert.equal(parseIntentResponse(JSON.stringify({ answers: {} }), valid), undefined);
  assert.equal(parseIntentResponse(JSON.stringify({ answers: { hypothesis: { type: "choice", choice: "invented" } } }), valid), undefined);
});

test("metrics: accuracy, calibration, uncertain rate, precision@threshold, per family", () => {
  const results: IntentResult[] = [
    { caseId: "a", family: "missing-read", label: "intent.read-existing-file", status: "answered", choice: "intent.read-existing-file", confidence: 0.99, latencyMs: 10 },
    { caseId: "b", family: "missing-read", label: "intent.create-then-read", status: "answered", choice: "intent.read-existing-file", confidence: 0.7, latencyMs: 10 },
    { caseId: "c", family: "ambiguous-edit", label: "intent.different-occurrence", status: "uncertain", choice: "uncertain", confidence: 0.3, latencyMs: 10 },
    { caseId: "d", family: "edit-mismatch", label: "unresolvable", status: "answered", choice: "intent.content-drifted", confidence: 0.99, latencyMs: 10 },
  ];
  const metrics = evaluateIntent(results);
  assert.equal(metrics.cases, 4);
  assert.equal(metrics.labeled, 3);
  assert.equal(metrics.attempted, 3);
  assert.equal(metrics.correct, 1);
  assert.equal(metrics.top1Accuracy, 1 / 3);
  assert.equal(metrics.uncertain, 1);
  assert.equal(metrics.uncertainRate, 0.25);
  assert.equal(metrics.highConfidenceAttempted, 2);
  assert.equal(metrics.highConfidenceCorrect, 1);
  assert.equal(metrics.precisionAtThreshold, 0.5);
  assert.equal(metrics.unresolvable, 1);

  const bucket099 = metrics.calibration.find((bucket) => bucket.id === ">=0.99")!;
  assert.equal(bucket099.attempts, 2);
  assert.equal(bucket099.correct, 1);
  assert.equal(bucket099.accuracy, 0.5);
  const bucket07 = metrics.calibration.find((bucket) => bucket.id === "0.50-0.79")!;
  assert.equal(bucket07.attempts, 1);
  assert.equal(bucket07.accuracy, 0);

  const missingRead = metrics.families.find((family) => family.family === "missing-read")!;
  assert.equal(missingRead.attempted, 2);
  assert.equal(missingRead.correct, 1);
  assert.equal(missingRead.accuracy, 0.5);
  assert.equal(missingRead.precisionAtThreshold, 1);
  assert.equal(INTENT_THRESHOLD, 0.99);
});
