import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_TIMEOUT_MAX_SECONDS,
  MAX_CANDIDATES,
  MAX_VALUE_CHARS,
  buildMappingRequest,
  decideMapping,
  enumerateCommandMapping,
  evaluateMappings,
  extractMappingEpisodes,
  featuresOf,
  mappingOptions,
  parseMappingResponse,
  type LabelledMappingCase,
  type MappingEvent,
  type MappingMetrics,
  type MappingOutcome,
} from "./index.ts";

test("enumerates arbitrary safe string keys alphabetically without an alias list", () => {
  const enumeration = enumerateCommandMapping("write", { CMD: "ls -la", zebra: "echo hi", alpha: "pwd" });
  assert.equal(enumeration.status, "candidates");
  assert.deepEqual(enumeration.candidates.map((candidate) => candidate.key), ["CMD", "alpha", "zebra"]);
  assert.deepEqual(enumeration.candidates.map((candidate) => candidate.ordinal), [1, 2, 3]);
  assert.deepEqual(enumeration.candidates.map((candidate) => candidate.value), ["ls -la", "pwd", "echo hi"]);
});

test("supports canonical and arbitrary keys together and keeps the timeout out of the candidates", () => {
  const enumeration = enumerateCommandMapping("edit", { bash: "git status", timeout: 30 });
  assert.equal(enumeration.status, "candidates");
  assert.deepEqual(enumeration.candidates.map((candidate) => candidate.key), ["bash"]);
  assert.equal(enumeration.canonicalTimeout, true);

  const caseVariant = enumerateCommandMapping("read", { COMMAND: "ls" });
  assert.equal(caseVariant.status, "candidates");
  assert.deepEqual(caseVariant.candidates.map((candidate) => candidate.key), ["COMMAND"]);
});

test("abstains on unexplained fields, nested values, arrays, unsafe keys, and invalid timeouts", () => {
  const cases: [string, unknown, string][] = [
    ["extra scalar field", { command: "ls", depth: 3 }, "unexplained-field"],
    ["nested object", { command: "ls", opts: { a: 1 } }, "unexplained-field"],
    ["array field", { command: "ls", flags: ["-l"] }, "unexplained-field"],
    ["unsafe key", { "bad key!": "ls" }, "unsafe-key"],
    ["invalid timeout", { command: "ls", timeout: -1 }, "invalid-timeout"],
    ["no candidates", { timeout: 5 }, "no-candidates"],
    ["non-object", "ls", "not-an-object"],
  ];
  for (const [label, input, reason] of cases) {
    const enumeration = enumerateCommandMapping("write", input);
    assert.equal(enumeration.status, "abstain", label);
    assert.equal(enumeration.reason, reason, label);
  }
  assert.equal(enumerateCommandMapping("bash", { command: "ls" }).reason, "not-a-source-tool");
  assert.equal(enumerateCommandMapping("ast_map", { command: "ls" }).reason, "not-a-source-tool");
});

test("abstains when there are more than five candidates or an oversized value", () => {
  const many = Object.fromEntries(Array.from({ length: MAX_CANDIDATES + 1 }, (_, index) => [`k${index}`, `echo ${index}`]));
  assert.equal(enumerateCommandMapping("write", many).reason, "too-many-candidates");

  const oversized = { command: "x".repeat(MAX_VALUE_CHARS + 1) };
  assert.equal(enumerateCommandMapping("write", oversized).reason, "oversized-value");

  const exactly = Object.fromEntries(Array.from({ length: MAX_CANDIDATES }, (_, index) => [`k${index}`, `echo ${index}`]));
  assert.equal(enumerateCommandMapping("write", exactly).status, "candidates");
});

test("empty strings are ignored and an empty object abstains", () => {
  const withEmpty = enumerateCommandMapping("write", { command: "", other: "   ", real: "ls" });
  assert.equal(withEmpty.status, "candidates");
  assert.deepEqual(withEmpty.candidates.map((candidate) => candidate.key), ["real"]);
  assert.equal(enumerateCommandMapping("write", {}).reason, "no-candidates");
});

test("derived features are closed observations and never include the value", () => {
  const shell = featuresOf("git commit -m 'x' && echo done");
  assert.equal(shell.shape, "shell-like");
  assert.equal(shell.shellOperator, true);
  assert.equal(shell.executableLike, true);

  const plain = featuresOf("ls");
  assert.equal(plain.tokenBucket, "one");
  assert.equal(plain.executableLike, true);

  const path = featuresOf("/usr/local/bin/tool");
  assert.equal(path.pathLike, true);
  assert.equal(path.executableLike, false);

  const prose = featuresOf("The user asked me to run the test suite.");
  assert.equal(prose.proseLike, true);
  assert.equal(prose.shape, "prose-like");

  const redirect = featuresOf("cat file > out.txt");
  assert.equal(redirect.redirection, true);

  const assignment = featuresOf("FOO=1 make build");
  assert.equal(assignment.assignment, true);

  const serialized = JSON.stringify(shell);
  assert.equal(serialized.includes("git commit"), false, "features never carry the value");
});

test("the request carries keys, features, and ordinals only", () => {
  const enumeration = enumerateCommandMapping("write", { CMD: "SECRET_COMMAND --flag /Users/me/x", timeout: 5 });
  assert.equal(enumeration.status, "candidates");
  const request = JSON.stringify(buildMappingRequest("write", enumeration.candidates, { canonicalTimeout: enumeration.canonicalTimeout }));
  for (const forbidden of ["SECRET_COMMAND", "--flag", "/Users/", "SECRET"]) {
    assert.equal(request.includes(forbidden), false, `request leaked: ${forbidden}`);
  }
  const parsed = JSON.parse(request);
  assert.equal(parsed.state.failedTool, "write");
  assert.equal(parsed.state.failureClass, "schema-validation");
  assert.equal(parsed.state.canonicalTimeout, true);
  assert.deepEqual(Object.keys(parsed.questions.mapping.criteria).sort(), mappingOptions(1).sort());
  assert.deepEqual(parsed.state.candidates[0].key, "CMD");
  assert.equal(parsed.state.candidates[0].executableLike, true);
});

test("hardened parsing fails closed", () => {
  const options = mappingOptions(2);
  const probabilities = { "candidate-1": 0.8, "candidate-2": 0.15, none: 0.05 };
  const valid = JSON.stringify({ answers: { mapping: { type: "choice", choice: "candidate-1", confidence: 0.8, probabilities } } });
  assert.equal(parseMappingResponse(valid, options)?.choice, "candidate-1");
  assert.equal(parseMappingResponse(JSON.stringify({ answers: { mapping: { type: "choice", choice: "candidate-9", probabilities } } }), options), undefined);
  assert.equal(parseMappingResponse(JSON.stringify({ answers: { mapping: { type: "choice", choice: "candidate-1", confidence: 2, probabilities } } }), options), undefined);
  assert.equal(parseMappingResponse(JSON.stringify({ answers: { mapping: { type: "choice", choice: "candidate-1", probabilities: { "candidate-1": 0.9, none: 0.1 } } } }), options), undefined, "missing key");
  assert.equal(parseMappingResponse("nope", options), undefined);
});

function call(id: string, toolName: string, args: Record<string, unknown>, index = 0): MappingEvent[] {
  return [{ id: `c${index}`, ts: "t", kind: "toolCall", toolName, toolCallId: id, args }];
}
function result(id: string, isError: boolean, errorText = "", index = 0): MappingEvent[] {
  return [{ id: `r${index}`, ts: "t", kind: "toolResult", toolCallId: id, isError, ...(errorText ? { errorText } : {}) }];
}
const validationError = (tool: string) => `Validation failed for tool "${tool}":\n  - path: must have required properties path, content\n\nReceived arguments:\n{ "CMD": "git status" }`;

test("mining labels the later corrected call that carries a candidate value as its command", () => {
  const events: MappingEvent[] = [
    ...call("f1", "write", { CMD: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git status" }, 1),
    ...result("s1", false, "", 1),
  ];
  const { episodes, attrition } = extractMappingEpisodes("session-1", events);
  assert.equal(attrition.mined, 1);
  assert.equal(attrition.enumerated, 1);
  assert.equal(attrition.labelled, 1);
  assert.equal(episodes[0]!.labelOrdinal, 1);
  assert.equal(episodes[0]!.candidates[0]!.key, "CMD");
});

test("mining requires the anchored header tool to match and a bounded corrected call", () => {
  const mismatched: MappingEvent[] = [
    ...call("f1", "write", { CMD: "git status" }, 0),
    ...result("f1", true, validationError("edit"), 0),
  ];
  assert.equal(extractMappingEpisodes("s", mismatched).attrition.mined, 0);

  const noCorrection: MappingEvent[] = [
    ...call("f1", "write", { CMD: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
  ];
  assert.equal(extractMappingEpisodes("s", noCorrection).attrition.noLaterCall, 1);

  const wrongValue: MappingEvent[] = [
    ...call("f1", "write", { CMD: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "different" }, 1),
    ...result("s1", false, "", 1),
  ];
  assert.equal(extractMappingEpisodes("s", wrongValue).attrition.labelled, 0, "the later command must match a candidate verbatim");

  const tooFar: MappingEvent[] = [
    ...call("f1", "write", { CMD: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("p1", "read", { path: "a" }, 1), ...result("p1", false, "", 1),
    ...call("p2", "read", { path: "b" }, 2), ...result("p2", false, "", 2),
    ...call("p3", "read", { path: "c" }, 3), ...result("p3", false, "", 3),
    ...call("s1", "bash", { command: "git status" }, 4), ...result("s1", false, "", 4),
  ];
  assert.equal(extractMappingEpisodes("s", tooFar).attrition.labelled, 0, "outside the three-call window");
});

test("metrics split thresholds, calibration, baselines, and abstention", () => {
  const labelable: LabelledMappingCase[] = [
    { caseId: "a", sessionId: "s1", labelOrdinal: 1, baselineAlias: 1, baselineFirst: 1 },
    { caseId: "b", sessionId: "s1", labelOrdinal: 2, baselineAlias: 1, baselineFirst: 1 },
    { caseId: "c", sessionId: "s2", labelOrdinal: 2, baselineAlias: 2, baselineFirst: 1 },
  ];
  const results: MappingOutcome[] = [
    { caseId: "a", sessionId: "s1", status: "answered", choice: "candidate-1", confidence: 0.95, latencyMs: 1 },
    { caseId: "b", sessionId: "s1", status: "answered", choice: "candidate-2", confidence: 0.5, latencyMs: 1 },
    { caseId: "c", sessionId: "s2", status: "abstained", latencyMs: 1 },
  ];
  const metrics = evaluateMappings(labelable, results);
  assert.equal(metrics.labelable, 3);
  assert.equal(metrics.attempted, 2);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.accuracy, 1);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.baselineAliasCorrect, 2);
  assert.equal(metrics.baselineAliasAccuracy, 2 / 3);
  assert.equal(metrics.baselineFirstAccuracy, 1 / 3);
  assert.equal(metrics.distinctSessions, 2);
  const at90 = metrics.thresholds.find((entry) => entry.threshold === 0.9)!;
  assert.equal(at90.selections, 1);
  assert.equal(at90.correct, 1);
  assert.equal(at90.precision, 1);
});

test("the promotion gate requires volume, coverage, zero wrong, and beating baselines", () => {
  const metrics = (overrides: Partial<MappingMetrics> = {}): MappingMetrics => ({
    labelable: 40, attempted: 40, correct: 40, accuracy: 1, abstained: 0, malformed: 0, failed: 0, candidatesMean: 0,
    thresholds: [
      { threshold: 0.9, selections: 40, correct: 40, precision: 1, coverage: 1 },
      { threshold: 0.99, selections: 40, correct: 40, precision: 1, coverage: 1 },
    ],
    calibration: [], baselineAliasCorrect: 20, baselineAliasAccuracy: 0.5, baselineFirstAccuracy: 0.4,
    distinctSessions: 10, topSessionConcentration: [],
    ...overrides,
  });

  assert.equal(decideMapping(0.9, metrics(), 40).verdict, "reject", "coverage below the gate");
  assert.equal(decideMapping(0.96, metrics(), 10).verdict, "reject", "insufficient cases");
  assert.equal(decideMapping(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 29, precision: 0.725, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "too few correct");
  assert.equal(decideMapping(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 39, precision: 0.975, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "wrong selection");
  assert.equal(decideMapping(0.96, metrics({ baselineAliasAccuracy: 1 }), 40).verdict, "shadow-only", "does not beat the alias baseline");
  assert.equal(decideMapping(0.96, metrics(), 40).verdict, "promote");
});
