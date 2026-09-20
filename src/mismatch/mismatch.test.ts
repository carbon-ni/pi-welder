import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_MISMATCH_CANDIDATES, candidateFeatures, generateMismatchCandidates, labelOrdinal } from "./candidates.ts";
import { boundedPriorSignals, extractMismatchCases, PRIOR_EVENT_WINDOW, type EditEvent } from "./episode.ts";
import { parseSessionText } from "./session.ts";
import {
  MISMATCH_PROMOTION_GATE,
  buildMismatchRequest,
  candidateOptions,
  computeCandidateCoverage,
  decideMismatch,
  evaluateMismatch,
  parseMismatchResponse,
  type MismatchMetrics,
  type MismatchResult,
} from "./evaluation.ts";

test("candidates are deterministic, bounded, deduplicated, and content-preserving", () => {
  const attempted = "  return value;\n";
  const first = generateMismatchCandidates(attempted);
  const second = generateMismatchCandidates(attempted);
  assert.deepEqual(second, first);
  assert.ok(first.length <= MAX_MISMATCH_CANDIDATES && first.length >= 1);
  assert.deepEqual(first.map((candidate) => candidate.ordinal), first.map((_, index) => index + 1));
  assert.deepEqual(first.map((candidate) => candidate.transform), ["verbatim", "indentation", "trimmed"]);
  // Dedup: identical transformations collapse.
  assert.equal(new Set(first.map((candidate) => candidate.text)).size, first.length);
});

test("candidate features carry buckets and ordinals only, never text", () => {
  const candidates = generateMismatchCandidates("a\r\nb\r\n");
  const features = candidates.map(candidateFeatures);
  const serialized = JSON.stringify(features);
  assert.doesNotMatch(serialized, /a\\r|b\\n|a\r|b\n/);
  for (const feature of features) {
    assert.deepEqual(Object.keys(feature).sort(), ["length", "lines", "ordinal", "similarity", "transform"]);
  }
  assert.equal(features[0]!.similarity, "identical");
});

test("labels come from the later successful anchor and never from generation", () => {
  const attempted = "  return value;\n";
  const candidates = generateMismatchCandidates(attempted);
  assert.equal(labelOrdinal(candidates, "  return value;\n"), 1);
  assert.equal(labelOrdinal(candidates, "return value;"), candidates.find((candidate) => candidate.transform === "trimmed")?.ordinal);
  assert.equal(labelOrdinal(candidates, "COMPLETELY DIFFERENT CONTENT"), undefined);
});

function events(list: EditEvent[]): EditEvent[] {
  return list;
}
function call(id: string, path: string, oldText: string, index = 0): EditEvent {
  return { id: `call-${index}-${id}`, ts: "t", kind: "toolCall", toolName: "edit", toolCallId: id, path, oldText, newText: "next" };
}
function result(id: string, isError: boolean, errorText?: string): EditEvent {
  return { id: `res-${id}`, ts: "t", kind: "toolResult", toolCallId: id, isError, ...(errorText === undefined ? {} : { errorText }) };
}

test("extracts a same-path recovery within the bounded call window", () => {
  const cases = extractMismatchCases("s", events([
    call("f1", "src/a.ts", "  old anchor", 1),
    result("f1", true, "Could not find edits[0] in src/a.ts. The oldText must match exactly including all whitespace."),
    call("s1", "src/a.ts", "  old anchor\n  extra", 2),
    result("s1", false),
  ]));
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.attemptedOldText, "  old anchor");
  assert.equal(cases[0]!.successfulOldText, "  old anchor\n  extra");
  assert.equal(cases[0]!.failureClass, "edit.oldtext-not-found");
  assert.deepEqual(cases[0]!.prior, { priorEditAttempts: 0, priorErrorCalls: 0, priorOkCalls: 0 });
});

test("aborts recovery on user intervention, different path, or non-edit mutation", () => {
  const failure = [call("f1", "src/a.ts", "anchor", 1), result("f1", true, "Could not find edits[0]. The oldText must match exactly.")];

  assert.equal(extractMismatchCases("s", events([
    ...failure,
    { id: "u", ts: "t", kind: "user" },
    call("s1", "src/a.ts", "anchor", 2),
    result("s1", false),
  ])).length, 0, "user intervention");

  assert.equal(extractMismatchCases("s", events([
    ...failure,
    call("s1", "src/other.ts", "anchor", 2),
    result("s1", false),
  ])).length, 0, "different path");

  assert.equal(extractMismatchCases("s", events([
    ...failure,
    { id: "w1", ts: "t", kind: "toolCall", toolName: "write", toolCallId: "w1", path: "src/a.ts" },
    result("w1", false),
  ])).length, 0, "non-edit mutation");
});

test("aborts when the recovery is beyond the call window or never succeeds", () => {
  const failure = [call("f1", "src/a.ts", "anchor", 1), result("f1", true, "Could not find edits[0]. The oldText must match exactly.")];
  const filler = [1, 2, 3].flatMap((n) => [call(`x${n}`, `src/f${n}.ts`, "x", n + 1), result(`x${n}`, true, "Could not find edits[0]. The oldText must match exactly.")]);

  assert.equal(extractMismatchCases("s", events([...failure, ...filler, call("late", "src/a.ts", "anchor", 9), result("late", false)])).length, 0);
  assert.equal(extractMismatchCases("s", events(failure)).length, 0);
});

test("the request carries only closed features: no paths, edit text, or identifiers", () => {
  const attempted = "SECRET_ANCHOR_TEXT";
  const candidates = generateMismatchCandidates(attempted);
  const evaluationCase = {
    caseId: "case-1",
    sessionId: "session-1",
    attemptedOldText: attempted,
    successfulOldText: "SECRET_SUCCESS_TEXT",
    failureClass: "edit.oldtext-not-found" as const,
    prior: { priorEditAttempts: 2, priorErrorCalls: 3, priorOkCalls: 1 },
  };
  const request = JSON.stringify(buildMismatchRequest(evaluationCase, candidates));
  for (const forbidden of ["SECRET_ANCHOR_TEXT", "SECRET_SUCCESS_TEXT", "src/", "case-1", "session-1", "oldText", "path"]) {
    assert.equal(request.includes(forbidden), false, `request leaked: ${forbidden}`);
  }
  const parsed = JSON.parse(request);
  assert.deepEqual(parsed.state.failureClass, "edit.oldtext-not-found");
  assert.deepEqual(parsed.state.prior, { priorEditAttempts: 2, priorErrorCalls: 3, priorOkCalls: 1 });
  assert.deepEqual(Object.keys(parsed.questions.candidate.criteria).sort(), candidateOptions(candidates).sort());
});

test("hardened parsing fails closed on unknown options and malformed probabilities", () => {
  const options = ["candidate-1", "candidate-2", "none"];
  const probabilities = { "candidate-1": 0.9, "candidate-2": 0.05, none: 0.05 };
  const valid = JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-1", confidence: 0.9, probabilities } } });
  assert.equal(parseMismatchResponse(valid, options)?.choice, "candidate-1");

  assert.equal(parseMismatchResponse(JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-9", confidence: 0.9, probabilities } } }), options), undefined);
  assert.equal(parseMismatchResponse(JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-1", confidence: 1.4, probabilities } } }), options), undefined);
  assert.equal(parseMismatchResponse(JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-1", probabilities: { "candidate-1": 0.9, none: 0.1 } } } }), options), undefined, "missing key");
  assert.equal(parseMismatchResponse(JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-1", probabilities: { ...probabilities, extra: 0 } } } }), options), undefined, "extra key");
  assert.equal(parseMismatchResponse(JSON.stringify({ answers: { candidate: { type: "choice", choice: "candidate-1", probabilities: { "candidate-1": 0.2, "candidate-2": 0.1, none: 0.1 } } } }), options), undefined, "sum off");
  assert.equal(parseMismatchResponse("nope", options), undefined);
});

test("parseSessionText joins calls and results into ordered edit events", () => {
  const lines = [
    JSON.stringify({ type: "session", id: "session-x" }),
    JSON.stringify({ type: "message", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "please edit" }] } }),
    JSON.stringify({ type: "message", timestamp: "t2", message: { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "anchor", newText: "next" }] } },
    ] } }),
    JSON.stringify({ type: "message", timestamp: "t3", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", isError: true, content: [{ type: "text", text: "Could not find edits[0]. The oldText must match exactly." }] } }),
    JSON.stringify({ type: "message", timestamp: "t4", message: { role: "assistant", content: [
      { type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "  anchor", newText: "next" }] } },
    ] } }),
    JSON.stringify({ type: "message", timestamp: "t5", message: { role: "toolResult", toolCallId: "c2", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] } }),
  ];

  const session = parseSessionText(lines.join("\n"));
  assert.equal(session.sessionId, "session-x");
  assert.deepEqual(session.events.map((event) => `${event.kind}:${event.toolCallId ?? event.id}`), ["user:0", "toolCall:c1", "toolResult:c1", "toolCall:c2", "toolResult:c2"]);
  assert.equal(session.events[1]!.oldText, "anchor");
  assert.equal(extractMismatchCases(session.sessionId, session.events).length, 1);
});

test("metrics include baseline comparison, calibration, and abstention", () => {
  const labelable = [{ caseId: "a", labelOrdinal: 1 }, { caseId: "b", labelOrdinal: 2 }, { caseId: "c", labelOrdinal: 1 }];
  const results: MismatchResult[] = [
    { caseId: "a", status: "answered", choice: "candidate-1", confidence: 0.99, latencyMs: 10 },
    { caseId: "b", status: "answered", choice: "candidate-1", confidence: 0.99, latencyMs: 10 },
    { caseId: "c", status: "abstained", latencyMs: 10 },
  ];
  const metrics = evaluateMismatch(labelable, results);
  assert.equal(metrics.attempted, 2);
  assert.equal(metrics.correct, 1);
  assert.equal(metrics.wrong, 1);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.highConfidenceSelections, 2);
  assert.equal(metrics.highConfidenceCorrect, 1);
  assert.equal(metrics.precisionAtThreshold, 0.5);
  assert.equal(metrics.coverage, 2 / 3);
  assert.equal(metrics.baselineCorrect, 2);
  assert.equal(metrics.baselineAccuracy, 2 / 3);
  assert.equal(metrics.calibration.find((bucket) => bucket.id === ">=0.99")!.accuracy, 0.5);
});

test("prior signals are bounded to three events before the call and never read future results", () => {
  // Parallel ordering: the failed call's window must not include results that
  // physically land after it, even though their calls precede it.
  const events: EditEvent[] = [
    { id: "c0", ts: "t", kind: "toolCall", toolName: "read", toolCallId: "c0", path: "src/x.ts" },
    { id: "c1", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "c1", path: "src/a.ts", oldText: "anchor" },
    { id: "r1", ts: "t", kind: "toolResult", toolCallId: "c1", isError: true, errorText: "Could not find edits[0]. The oldText must match exactly." },
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "c2", path: "src/a.ts", oldText: "  anchor" },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "c2", isError: false },
    { id: "r0", ts: "t", kind: "toolResult", toolCallId: "c0", isError: false },
  ];
  const prior = boundedPriorSignals(events, 1);
  assert.deepEqual(prior, { priorEditAttempts: 0, priorErrorCalls: 0, priorOkCalls: 0 }, "only the read call precedes the target");

  // Counters never exceed the window size.
  const many: EditEvent[] = Array.from({ length: 10 }, (_, index) => ({ id: `r${index}`, ts: "t", kind: "toolResult", toolCallId: `c${index}`, isError: index % 2 === 0 }));
  const bounded = boundedPriorSignals(many, many.length);
  assert.equal(bounded.priorErrorCalls + bounded.priorOkCalls <= PRIOR_EVENT_WINDOW, true);
});

test("prior signals count only the immediate pre-failure window", () => {
  const events: EditEvent[] = [
    { id: "c0", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "c0", path: "src/a.ts", oldText: "x" },
    { id: "r0", ts: "t", kind: "toolResult", toolCallId: "c0", isError: false },
    { id: "c1", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "c1", path: "src/a.ts", oldText: "anchor" },
    { id: "r1", ts: "t", kind: "toolResult", toolCallId: "c1", isError: true, errorText: "Could not find edits[0]. The oldText must match exactly." },
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "c2", path: "src/a.ts", oldText: "  anchor" },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "c2", isError: false },
  ];
  const cases = extractMismatchCases("s", events);
  assert.deepEqual(cases[0]!.prior, { priorEditAttempts: 1, priorErrorCalls: 0, priorOkCalls: 1 });
});

test("coverage and conditional recall are separate; the gate uses coverage", () => {
  const coverage = computeCandidateCoverage([{ labelOrdinal: 1 }, { labelOrdinal: 2 }, { labelOrdinal: undefined }, { labelOrdinal: undefined }]);
  assert.equal(coverage.cases, 4);
  assert.equal(coverage.labelable, 2);
  assert.equal(coverage.coverage, 0.5, "labelable / all mined candidate cases");
  assert.equal(coverage.conditionalTop1Recall, 0.5);
  assert.equal(coverage.conditionalTop5Recall, 1, "both labelable cases matched inside top-5");

  const goodMetrics = (): MismatchMetrics => ({
    cases: 40, attempted: 40, correct: 40, wrong: 0, accuracy: 1, abstained: 0, malformed: 0, failed: 0,
    highConfidenceSelections: 40, highConfidenceCorrect: 40, precisionAtThreshold: 1, coverage: 1,
    calibration: [], perTransform: [], baselineDenominator: 40, baselineCorrect: 20, baselineAccuracy: 0.5, latencyMs: 0,
  });

  assert.equal(decideMismatch(coverage, goodMetrics(), 10).verdict, "reject", "insufficient cases");
  assert.equal(decideMismatch({ ...coverage, coverage: 0.9 }, goodMetrics(), 40).verdict, "reject", "coverage below 0.95");
  assert.match(decideMismatch({ ...coverage, coverage: 0.9 }, goodMetrics(), 40).reason, /candidate-set coverage/);
  assert.equal(decideMismatch({ ...coverage, coverage: 0.96 }, { ...goodMetrics(), wrong: 1 }, 40).verdict, "shadow-only", "wrong selection");
  assert.equal(decideMismatch({ ...coverage, coverage: 0.96 }, { ...goodMetrics(), highConfidenceSelections: 10, highConfidenceCorrect: 10 }, 40).verdict, "shadow-only", "too few high-confidence");
  assert.equal(decideMismatch({ ...coverage, coverage: 0.96 }, goodMetrics(), 40).verdict, "promote");
  assert.deepEqual(MISMATCH_PROMOTION_GATE, { minCoverage: 0.95, minHighConfidenceSelections: 30, confidenceThreshold: 0.99, maxWrong: 0 });
});

test("per-transformation accuracy is reported for selected candidates", () => {
  const labelable = [{ caseId: "a", labelOrdinal: 1 }, { caseId: "b", labelOrdinal: 2 }, { caseId: "c", labelOrdinal: 3 }];
  const results: MismatchResult[] = [
    { caseId: "a", status: "answered", choice: "candidate-1", choiceTransform: "verbatim", confidence: 0.6, latencyMs: 1 },
    { caseId: "b", status: "answered", choice: "candidate-1", choiceTransform: "verbatim", confidence: 0.6, latencyMs: 1 },
    { caseId: "c", status: "answered", choice: "candidate-3", choiceTransform: "trimmed", confidence: 0.6, latencyMs: 1 },
  ];
  const metrics = evaluateMismatch(labelable, results);
  assert.deepEqual(metrics.perTransform, [
    { transform: "verbatim", attempts: 2, correct: 1, accuracy: 0.5 },
    { transform: "trimmed", attempts: 1, correct: 1, accuracy: 1 },
  ]);
  assert.equal(metrics.baselineDenominator, 3, "baseline denominator is the labelable count");
});
