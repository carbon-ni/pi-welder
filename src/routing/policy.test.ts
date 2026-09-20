import { test } from "node:test";
import assert from "node:assert/strict";

import { LABELED_FAILURES } from "./dataset.ts";
import { REPAIR_ACTIONS } from "../repairs/types.ts";
import { parseRouteAnswer, evaluateRouting, decideRouting, deterministicRoute, ROUTING_POLICY, type JevRouteResult } from "./policy.ts";
import { buildRoutingState } from "./sanitize.ts";
import type { RoutingState } from "./sanitize.ts";
import type { LabeledFailure } from "./dataset.ts";

test("the dataset has at least 30 cases, every label is an existing rule or none", () => {
  assert.ok(LABELED_FAILURES.length >= 30, `labels: ${LABELED_FAILURES.length}`);
  const known = new Set<string>([...REPAIR_ACTIONS, "none"]);
  for (const evaluationCase of LABELED_FAILURES) {
    assert.ok(known.has(evaluationCase.label), `unknown label ${evaluationCase.label}`);
  }
  assert.equal(new Set(LABELED_FAILURES.map((entry) => entry.caseId)).size, LABELED_FAILURES.length, "case ids unique");
  assert.ok(LABELED_FAILURES.some((entry) => entry.label === "none"), "legitimate none labels exist");
});

test("the dataset is sanitized: no real paths, homes, or secrets", () => {
  const serialized = JSON.stringify(LABELED_FAILURES);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|\.dotfiles/);
  assert.doesNotMatch(serialized, /\b(sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/u);
  assert.doesNotMatch(serialized, /-----BEGIN [^-]+-----/);
});

test("parseRouteAnswer fails closed on unknown output and abstention", () => {
  assert.equal(parseRouteAnswer("resolve-ambiguous-edit"), "resolve-ambiguous-edit");
  assert.equal(parseRouteAnswer("none"), "none");
  assert.equal(parseRouteAnswer("invented-rule"), undefined);
  assert.equal(parseRouteAnswer(null), undefined);
  assert.equal(parseRouteAnswer(undefined), undefined);
});

test("the deterministic baseline routes the obvious clusters and leaves the rest unresolved", () => {
  const routeFor = (toolName: string, errorKind: string, errorText: string) =>
    deterministicRoute({ toolName, errorKind, errorText });

  assert.equal(routeFor("read", "ENOENT", "ENOENT: no such file or directory, access 'src/a.ts'"), "missing-read-context");
  assert.equal(routeFor("read", "TOOL_ERROR", "Offset 900 is beyond end of file (42 lines total)"), "read-offset-context");
  assert.equal(routeFor("read", "EISDIR", "EISDIR: illegal operation on a directory, read"), "directory-read");
  assert.equal(routeFor("edit", "EDIT_NOT_UNIQUE", "Found 2 occurrences of the text in src/a.ts. The text must be unique."), "resolve-ambiguous-edit");
  assert.equal(routeFor("edit", "SCHEMA", "No changes made. The replacement produced identical content."), "edit-noop");
  assert.equal(routeFor("edit", "EDIT_NOT_FOUND", "Could not find edits[0] in src/a.ts. The oldText must match exactly."), undefined);
  assert.equal(routeFor("bash", "TOOL_ERROR", "Command exited with code 1"), undefined);
});

function statesFor(cases: readonly LabeledFailure[]): Map<string, RoutingState> {
  const states = new Map<string, RoutingState>();
  for (const evaluationCase of cases) {
    const state = buildRoutingState(evaluationCase);
    if (state) states.set(evaluationCase.caseId, state);
  }
  return states;
}

test("metrics exclude deterministically covered cases from Jev precision", () => {
  const cases: LabeledFailure[] = [
    { caseId: "deterministic", toolName: "read", errorKind: "ENOENT", errorText: "ENOENT", label: "missing-read-context" },
    { caseId: "jev-eligible", toolName: "edit", errorKind: "EDIT_NOT_FOUND", errorText: "Could not find edits[0] in src/a.ts.", label: "resolve-ambiguous-edit" },
  ];
  const states = statesFor(cases);
  const jev: JevRouteResult[] = [
    // Even if Jev (wrongly) answered on a deterministic case, it must not count.
    { caseId: "deterministic", status: "answered", answer: "none", confidence: 0.99, latencyMs: 10 },
    { caseId: "jev-eligible", status: "answered", answer: "resolve-ambiguous-edit", confidence: 0.99, latencyMs: 20 },
  ];
  const metrics = evaluateRouting(cases, states, jev);
  assert.equal(metrics.deterministicCovered, 1);
  assert.equal(metrics.labeledUnresolved, 1);
  assert.equal(metrics.jevAttempted, 1);
  assert.equal(metrics.jevCorrect, 1);
  assert.equal(metrics.marginalCoverage, 1);
  assert.equal(metrics.latencyMs, 20);
});

test("wrong mutating-rule selections are hard failures that block routing", () => {
  const cases: LabeledFailure[] = [
    { caseId: "c1", toolName: "edit", errorKind: "EDIT_NOT_FOUND", errorText: "Could not find edits[0] in src/a.ts.", label: "none" },
  ];
  const metrics = evaluateRouting(cases, statesFor(cases), [
    { caseId: "c1", status: "answered", answer: "nest-edit-fields", confidence: 0.99, latencyMs: 5 },
  ]);
  assert.equal(metrics.jevWrong, 1);
  assert.equal(metrics.jevUnsafeWrong, 1);
  assert.equal(decideRouting(metrics).decision, "don't-route");
});

test("a wrong non-mutating (result-repair) choice is counted but not unsafe", () => {
  const cases: LabeledFailure[] = [
    { caseId: "c1", toolName: "edit", errorKind: "EDIT_NOT_FOUND", errorText: "Could not find edits[0] in src/a.ts.", label: "none" },
  ];
  const metrics = evaluateRouting(cases, statesFor(cases), [
    { caseId: "c1", status: "answered", answer: "edit-noop", confidence: 0.99, latencyMs: 5 },
  ]);
  assert.equal(metrics.jevWrong, 1);
  assert.equal(metrics.jevUnsafeWrong, 0);
  assert.notEqual(decideRouting(metrics).decision, "don't-route-unsafe" as never);
});

test("decision: needs-more-data below the case minimum, don't-route below precision", () => {
  const base = {
    cases: 10, labeledUnresolved: 10, deterministicCovered: 0, deterministicCorrect: 0, deterministicCoverage: 0,
    deterministicPrecision: 0, jevEligible: 10, jevAttempted: 5, jevAbstained: 0, jevMalformed: 0, jevFailed: 0,
    jevCorrect: 5, jevWrong: 0, jevUnsafeWrong: 0, jevPrecision: 1, jevHighConfidenceAttempted: 5,
    jevPrecisionAtThreshold: 1, marginalCoverage: 5, latencyMs: 0,
  };
  assert.equal(decideRouting({ ...base, labeledUnresolved: ROUTING_POLICY.minLabeledUnresolved - 1 }).decision, "needs-more-data");
  assert.equal(decideRouting({ ...base, labeledUnresolved: 40, jevHighConfidenceAttempted: 40, jevPrecisionAtThreshold: 0.5 }).decision, "don't-route");
  assert.equal(decideRouting({ ...base, labeledUnresolved: 40, jevHighConfidenceAttempted: 40, jevPrecisionAtThreshold: 1 }).decision, "route");
});
