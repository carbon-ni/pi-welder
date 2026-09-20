import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_OCCURRENCES, buildOccurrenceCandidates, occurrenceOffsets, proveConstruction } from "./source.ts";
import { extractOccurrenceEpisodes, labelOccurrence, occurrenceCount, positionBucketFor, type OccurrenceEvent } from "./episode.ts";
import {
  OCCURRENCE_PROMOTION_GATE,
  buildOccurrenceRequest,
  decideOccurrences,
  evaluateOccurrences,
  occurrenceOptions,
  parseOccurrenceResponse,
  readDistanceBucketOf,
  type LabelableCase,
  type OccurrenceMetrics,
  type OccurrenceResult,
} from "./evaluation.ts";

const SOURCE = [
  "function alpha() {",
  "  return value;",
  "}",
  "function beta() {",
  "  return value;",
  "}",
].join("\n");

test("candidates extend each occurrence minimally and prove mutation safety", () => {
  const anchor = "  return value;";
  const candidates = buildOccurrenceCandidates(SOURCE, anchor, "  return next;");
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.ordinal), [1, 2]);
  for (const candidate of candidates) {
    assert.equal(candidate.unique, true);
    assert.equal(occurrenceOffsets(SOURCE, candidate.oldText).length, 1, "anchor unique in source");
    const proof = proveConstruction(candidate, anchor, "  return next;", SOURCE);
    assert.deepEqual(proof, { exactlyOneOccurrenceChanges: true, untouchedContextIdentical: true, replacementNeverGenerated: true });
    assert.equal(candidate.newText.includes("  return next;"), true);
  }
  assert.deepEqual(candidates.map((candidate) => candidate.position), ["first", "last"]);
  // Deterministic.
  assert.deepEqual(buildOccurrenceCandidates(SOURCE, anchor, "  return next;"), candidates);
});

test("candidates are bounded to five occurrences and deduplicated by construction", () => {
  const many = Array.from({ length: 7 }, (_, index) => `line ${index}: value;`).join("\n");
  const candidates = buildOccurrenceCandidates(many, "value;", "next;");
  assert.equal(candidates.length, MAX_OCCURRENCES);
  for (const candidate of candidates) assert.equal(occurrenceOffsets(many, candidate.oldText).length, 1);
});

test("occurrenceCount accepts only 2-5 reported occurrences", () => {
  assert.equal(occurrenceCount("Found 2 occurrences of edits[1] in x. Each oldText must be unique."), 2);
  assert.equal(occurrenceCount("Found 5 occurrences of the text in x."), 5);
  assert.equal(occurrenceCount("Found 6 occurrences of the text in x."), undefined);
  assert.equal(occurrenceCount("Found 1 occurrences of the text in x."), undefined);
  assert.equal(occurrenceCount(undefined), undefined);
  assert.equal(positionBucketFor(1, 3), "first");
  assert.equal(positionBucketFor(2, 3), "middle");
  assert.equal(positionBucketFor(3, 3), "last");
});

test("the success search is bounded to three following tool calls", () => {
  const anchor = "  return value;";
  const success = (suffix: string): OccurrenceEvent[] => [
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "s1", path: "src/a.ts", oldText: "function beta() {\n  return value;\n}", newText: suffix },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "s1", toolName: "edit", isError: false },
  ];
  const padded = (count: number): OccurrenceEvent[] => Array.from({ length: count }, (_, index) => readCall(`p${index}`, "src/a.ts", SOURCE, 10 + index)).flat();

  // Success as the third following call: labelable.
  const withinBound: OccurrenceEvent[] = [ ...failedEdit("f1", "src/a.ts", anchor, "  return next;"), ...readCall("rd1", "src/a.ts", SOURCE, 1), ...padded(1), ...success("x") ];
  assert.equal(extractOccurrenceEpisodes("s", withinBound).attrition.labelable, 1);

  // Success as the fourth following call: out of bound, no label.
  const afterBound: OccurrenceEvent[] = [ ...failedEdit("f1", "src/a.ts", anchor, "  return next;"), ...readCall("rd1", "src/a.ts", SOURCE, 1), ...padded(2), ...success("x") ];
  assert.equal(extractOccurrenceEpisodes("s", afterBound).attrition.labelable, 0);

  // A mutation before the success stops the search.
  const mutated: OccurrenceEvent[] = [
    ...failedEdit("f1", "src/a.ts", anchor, "  return next;"),
    ...readCall("rd1", "src/a.ts", SOURCE, 1),
    { id: "w", ts: "t", kind: "toolCall", toolName: "write", toolCallId: "w1", path: "src/a.ts" },
    { id: "wr", ts: "t", kind: "toolResult", toolCallId: "w1", toolName: "write", isError: false },
    ...success("x"),
  ];
  assert.equal(extractOccurrenceEpisodes("s", mutated).attrition.labelable, 0);
});

test("only a prior read of the same target supplies the recent-read relation", () => {
  const anchor = "  return value;";
  const success: OccurrenceEvent[] = [
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "s1", path: "src/a.ts", oldText: "function beta() {\n  return value;\n}", newText: "x" },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "s1", toolName: "edit", isError: false },
  ];
  const otherTarget: OccurrenceEvent[] = [ ...readCall("ro", "src/other.ts", "unrelated", 0), ...failedEdit("f1", "src/a.ts", anchor, "  return next;"), ...readCall("rd1", "src/a.ts", SOURCE, 1), ...success ];
  const sameTarget: OccurrenceEvent[] = [ ...readCall("ra", "src/a.ts", SOURCE, 0), ...failedEdit("f1", "src/a.ts", anchor, "  return next;"), ...readCall("rd1", "src/a.ts", SOURCE, 1), ...success ];

  const unrelated = extractOccurrenceEpisodes("s", otherTarget).episodes[0]!;
  assert.equal(unrelated.priorReadOffset, undefined, "unrelated prior read must not drive features or baseline");
  const related = extractOccurrenceEpisodes("s", sameTarget).episodes[0]!;
  assert.equal(related.priorReadOffset, 1);
  assert.equal(related.priorReadLimit, 200);
});

test("the construction proof holds for an empty replacement", () => {
  const anchor = "  return value;";
  const candidates = buildOccurrenceCandidates(SOURCE, anchor, "");
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.deepEqual(proveConstruction(candidate, anchor, "", SOURCE), { exactlyOneOccurrenceChanges: true, untouchedContextIdentical: true, replacementNeverGenerated: true });
    assert.equal(candidate.newText.length, candidate.oldText.length - anchor.length, "deletion removes only the anchor");
    assert.equal(candidate.newText.includes(anchor), false);
  }
});

test("the construction proof holds when the replacement also occurs in context", () => {
  // Hand-built candidate: the untouched prefix also contains the replacement text,
  // so an indexOf/split-based proof would report a false negative.
  const source = "const value = 1;\nuse(value);\nuse(value);\n";
  const anchor = "use(value);";
  const replacement = "value";
  const candidate = {
    ordinal: 1,
    oldText: "const value = 1;\nuse(value);",
    newText: "const value = 1;\nvalue",
    unique: true,
    contextChars: 17,
    contextBucket: "short" as const,
    position: "first" as const,
    startOffset: 17,
    extensionStart: 0,
    extensionEnd: 28,
  };
  assert.equal(candidate.newText.split(replacement).length > 2, true, "replacement text appears in context and as the swap-in");
  assert.deepEqual(proveConstruction(candidate, anchor, replacement, source), { exactlyOneOccurrenceChanges: true, untouchedContextIdentical: true, replacementNeverGenerated: true });
});

test("overlapping anchors use non-overlapping stride semantics deterministically", () => {
  const source = "ababa";
  const anchor = "aba";
  assert.deepEqual(occurrenceOffsets(source, anchor), [0], "stride is anchor length: overlapping matches are not double-counted");
  const candidates = buildOccurrenceCandidates(source, anchor, "x");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.unique, true);
  assert.deepEqual(proveConstruction(candidates[0]!, anchor, "x", source), { exactlyOneOccurrenceChanges: true, untouchedContextIdentical: true, replacementNeverGenerated: true });
  assert.deepEqual(buildOccurrenceCandidates(source, anchor, "x"), candidates);
});

test("labels the occurrence contained in the later successful anchor", () => {
  assert.equal(labelOccurrence(SOURCE, "  return value;", "function beta() {\n  return value;\n}"), 2);
  assert.equal(labelOccurrence(SOURCE, "  return value;", "function alpha() {\n  return value;\n}"), 1);
  assert.equal(labelOccurrence(SOURCE, "  return value;", "  return value;"), undefined, "success span does not separate occurrences");
});

function readCall(id: string, path: string, content: string, index = 0, offset = 1, limit = 200): OccurrenceEvent[] {
  return [
    { id: `c${index}`, ts: "t", kind: "toolCall", toolName: "read", toolCallId: id, path, offset, limit },
    { id: `r${index}`, ts: "t", kind: "toolResult", toolCallId: id, toolName: "read", isError: false, content },
  ];
}
function failedEdit(id: string, path: string, anchor: string, replacement: string): OccurrenceEvent[] {
  return [
    { id: `c-${id}`, ts: "t", kind: "toolCall", toolName: "edit", toolCallId: id, path, oldText: anchor, newText: replacement },
    { id: `r-${id}`, ts: "t", kind: "toolResult", toolCallId: id, toolName: "edit", isError: true, errorText: "Found 2 occurrences of edits[0] in x. Each oldText must be unique." },
  ];
}

test("reconstructs source only from a following read with no user or mutation first", () => {
  const anchor = "  return value;";
  const events: OccurrenceEvent[] = [
    ...failedEdit("f1", "src/a.ts", anchor, "  return next;"),
    ...readCall("rd1", "src/a.ts", SOURCE, 1),
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "s1", path: "src/a.ts", oldText: "function beta() {\n  return value;\n}", newText: "function beta() {\n  return next;\n}" },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "s1", toolName: "edit", isError: false },
  ];
  const { episodes, attrition } = extractOccurrenceEpisodes("session-1", events);
  assert.equal(attrition.mined, 1);
  assert.equal(attrition.sourceReconstructed, 1);
  assert.equal(attrition.labelable, 1);
  assert.equal(episodes[0]!.labelOrdinal, 2);
  assert.equal(episodes[0]!.occurrences, 2);

  // A user event before the read invalidates reconstruction.
  const withUser: OccurrenceEvent[] = [ ...failedEdit("f1", "src/a.ts", anchor, "  return next;"), { id: "u", ts: "t", kind: "user" }, ...readCall("rd1", "src/a.ts", SOURCE, 2) ];
  assert.equal(extractOccurrenceEpisodes("s", withUser).attrition.sourceReconstructed, 0);

  // A mutation before the read invalidates reconstruction.
  const withMutation: OccurrenceEvent[] = [
    ...failedEdit("f1", "src/a.ts", anchor, "  return next;"),
    { id: "w", ts: "t", kind: "toolCall", toolName: "write", toolCallId: "w1", path: "src/a.ts" },
    { id: "wr", ts: "t", kind: "toolResult", toolCallId: "w1", toolName: "write", isError: false },
    ...readCall("rd1", "src/a.ts", SOURCE, 3),
  ];
  assert.equal(extractOccurrenceEpisodes("s", withMutation).attrition.sourceReconstructed, 0);
});

test("extraction requires a later successful same-path edit within the window", () => {
  const anchor = "  return value;";
  const noSuccess: OccurrenceEvent[] = [...failedEdit("f1", "src/a.ts", anchor, "  return next;"), ...readCall("rd1", "src/a.ts", SOURCE, 1)];
  assert.equal(extractOccurrenceEpisodes("s", noSuccess).attrition.labelable, 0);

  const differentPath: OccurrenceEvent[] = [
    ...failedEdit("f1", "src/a.ts", anchor, "  return next;"),
    ...readCall("rd1", "src/a.ts", SOURCE, 1),
    { id: "c2", ts: "t", kind: "toolCall", toolName: "edit", toolCallId: "s1", path: "src/b.ts", oldText: "function beta() {\n  return value;\n}", newText: "x" },
    { id: "r2", ts: "t", kind: "toolResult", toolCallId: "s1", toolName: "edit", isError: false },
  ];
  assert.equal(extractOccurrenceEpisodes("s", differentPath).attrition.labelable, 0);
});

test("the request carries closed features only: no source, anchors, paths, or identifiers", () => {
  const anchor = "SECRET_ANCHOR";
  const source = `${anchor}\nmid\n${anchor}`;
  const candidates = buildOccurrenceCandidates(source, anchor, "SECRET_REPLACEMENT");
  const features = candidates.map((candidate) => ({ ordinal: candidate.ordinal, position: candidate.position, readRelation: "before" as const, readDistance: "near" as const, contextLength: candidate.contextBucket }));
  const episode = { episodeId: "e1", sessionId: "session-1", anchor, replacement: "SECRET_REPLACEMENT", occurrences: 2, source, labelOrdinal: 1 };
  const request = JSON.stringify(buildOccurrenceRequest(episode, features));
  for (const forbidden of ["SECRET_ANCHOR", "SECRET_REPLACEMENT", "source", "session-1", "e1", "mid"]) {
    assert.equal(request.includes(forbidden), false, `request leaked: ${forbidden}`);
  }
  const parsed = JSON.parse(request);
  assert.equal(parsed.state.occurrences, 2);
  assert.deepEqual(Object.keys(parsed.questions.occurrence.criteria).sort(), occurrenceOptions(candidates).sort());
  assert.equal(readDistanceBucketOf(3), "near");
  assert.equal(readDistanceBucketOf(12), "mid");
  assert.equal(readDistanceBucketOf(50), "far");
  assert.equal(readDistanceBucketOf(undefined), "unknown");
});

test("hardened parsing fails closed on unknown options, malformed probabilities, and sums", () => {
  const options = ["candidate-1", "candidate-2", "none"];
  const probabilities = { "candidate-1": 0.9, "candidate-2": 0.05, none: 0.05 };
  const valid = JSON.stringify({ answers: { occurrence: { type: "choice", choice: "candidate-1", confidence: 0.9, probabilities } } });
  assert.equal(parseOccurrenceResponse(valid, options)?.choice, "candidate-1");
  assert.equal(parseOccurrenceResponse(JSON.stringify({ answers: { occurrence: { type: "choice", choice: "candidate-9", probabilities } } }), options), undefined);
  assert.equal(parseOccurrenceResponse(JSON.stringify({ answers: { occurrence: { type: "choice", choice: "candidate-1", confidence: 2, probabilities } } }), options), undefined);
  assert.equal(parseOccurrenceResponse(JSON.stringify({ answers: { occurrence: { type: "choice", choice: "candidate-1", probabilities: { "candidate-1": 0.9, none: 0.1 } } } }), options), undefined, "missing key");
  assert.equal(parseOccurrenceResponse(JSON.stringify({ answers: { occurrence: { type: "choice", choice: "candidate-1", probabilities: { "candidate-1": 0.2, "candidate-2": 0.1, none: 0.1 } } } }), options), undefined, "sum off");
  assert.equal(parseOccurrenceResponse("nope", options), undefined);
});

test("metrics report thresholds, baselines, calibration, and concentration", () => {
  const labelable: LabelableCase[] = [
    { caseId: "a", sessionId: "s1", labelOrdinal: 1, baselineNearest: 1 },
    { caseId: "b", sessionId: "s1", labelOrdinal: 2, baselineNearest: 1 },
    { caseId: "c", sessionId: "s2", labelOrdinal: 2, baselineNearest: undefined },
    { caseId: "d", sessionId: "s2", labelOrdinal: 1, baselineNearest: 2 },
  ];
  const results: OccurrenceResult[] = [
    { caseId: "a", sessionId: "s1", status: "answered", choice: "candidate-1", confidence: 0.95, latencyMs: 1 },
    { caseId: "b", sessionId: "s1", status: "answered", choice: "candidate-2", confidence: 0.99, latencyMs: 1 },
    { caseId: "c", sessionId: "s2", status: "abstained", latencyMs: 1 },
    { caseId: "d", sessionId: "s2", status: "answered", choice: "candidate-1", confidence: 0.5, latencyMs: 1 },
  ];
  const metrics = evaluateOccurrences(labelable, results);
  assert.equal(metrics.attempted, 3);
  assert.equal(metrics.correct, 3);
  assert.equal(metrics.accuracy, 1);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.baselineFirstCorrect, 2);
  assert.equal(metrics.baselineFirstAccuracy, 0.5);
  assert.equal(metrics.baselineNearestDenominator, 3);
  assert.equal(metrics.baselineNearestCorrect, 1);
  assert.equal(metrics.baselineNearestAccuracy, 1 / 3);
  assert.equal(metrics.distinctSessions, 2);
  assert.equal(metrics.topSessionConcentration[0]!.cases, 2);

  const at90 = metrics.thresholds.find((entry) => entry.threshold === 0.9)!;
  assert.equal(at90.selections, 2);
  assert.equal(at90.correct, 2);
  assert.equal(at90.precision, 1);
  assert.equal(at90.coverage, 0.5);
  const at99 = metrics.thresholds.find((entry) => entry.threshold === 0.99)!;
  assert.equal(at99.selections, 1);
  assert.equal(at99.correct, 1);
});

test("the promotion gate requires coverage, volume, baseline superiority, and zero wrong", () => {
  const metrics = (overrides: Partial<OccurrenceMetrics> = {}): OccurrenceMetrics => ({
    labelable: 40, attempted: 40, correct: 40, accuracy: 1, abstained: 0, malformed: 0, failed: 0,
    thresholds: [
      { threshold: 0.9, selections: 40, correct: 40, precision: 1, coverage: 1 },
      { threshold: 0.99, selections: 40, correct: 40, precision: 1, coverage: 1 },
    ],
    calibration: [], baselineFirstCorrect: 20, baselineFirstAccuracy: 0.5, baselineNearestDenominator: 40, baselineNearestCorrect: 20, baselineNearestAccuracy: 0.5,
    distinctSessions: 10, topSessionConcentration: [], latencyMs: 0,
    ...overrides,
  });

  assert.equal(decideOccurrences(0.9, metrics(), 40).verdict, "reject", "coverage below 0.95");
  assert.equal(decideOccurrences(0.96, metrics(), 10).verdict, "reject", "insufficient cases");
  assert.equal(decideOccurrences(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 25, precision: 0.625, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "too few correct at threshold");
  assert.equal(decideOccurrences(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 39, precision: 0.975, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "wrong selection");
  assert.equal(decideOccurrences(0.96, metrics({ baselineFirstAccuracy: 1 }), 40).verdict, "shadow-only", "does not beat first baseline");
  assert.equal(decideOccurrences(0.96, metrics(), 40).verdict, "promote");
  assert.deepEqual(OCCURRENCE_PROMOTION_GATE, { minCoverage: 0.95, minSelections: 30, threshold: 0.9, maxWrong: 0 });
});
