import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_TIMEOUT_MAX_SECONDS,
  MAX_CANDIDATES,
  MAX_VALUE_CHARS,
  buildMappingRequest,
  createMappingShadow,
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

test("the shadow observer never mutates arguments and records privacy-safe evidence", async () => {
  const args = { CMD: "SECRET_COMMAND", timeout: 5 };
  const snapshot = JSON.stringify(args);
  const evidence: any[] = [];
  const shadow = createMappingShadow({
    isEnabled: () => true,
    client: { choose: async () => ({ answers: { mapping: { type: "choice", choice: "candidate-1", confidence: 0.9, probabilities: { "candidate-1": 0.9, none: 0.1 } } } }) },
    onEvidence: (entry) => evidence.push(entry),
  });

  const enumeration = shadow.observe({ toolCallId: "call-1", toolName: "write", args });
  assert.equal(enumeration.status, "candidates");
  assert.equal(JSON.stringify(args), snapshot, "arguments are never mutated");
  await shadow.drain();

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].status, "selected");
  assert.equal(evidence[0].selectedOrdinal, 1);
  assert.equal(JSON.stringify(evidence).includes("SECRET_COMMAND"), false, "evidence never contains the value");
});

test("the shadow observer stays local when disabled and when the shape is ineligible", async () => {
  let calls = 0;
  const disabled = createMappingShadow({
    isEnabled: () => false,
    client: { choose: async () => { calls++; return {}; } },
  });
  const enumeration = disabled.observe({ toolCallId: "c", toolName: "write", args: { CMD: "ls" } });
  assert.equal(enumeration.status, "candidates", "enumeration is still local and useful");
  await disabled.drain();
  assert.equal(calls, 0, "nothing leaves the machine while disabled");

  const ineligible = disabled.observe({ toolCallId: "c2", toolName: "write", args: { command: "ls", depth: 3 } });
  assert.equal(ineligible.status, "abstain");
  await disabled.drain();
  assert.equal(calls, 0);
});

test("the shadow observer reports malformed and unavailable answers without throwing", async () => {
  const evidence: any[] = [];
  const malformed = createMappingShadow({
    isEnabled: () => true,
    client: { choose: async () => "not json" },
    onEvidence: (entry) => evidence.push(entry),
  });
  malformed.observe({ toolCallId: "m", toolName: "write", args: { CMD: "ls" } });
  await malformed.drain();

  const unavailable = createMappingShadow({
    isEnabled: () => true,
    client: { choose: async () => { throw new Error("offline"); } },
    onEvidence: (entry) => evidence.push(entry),
  });
  unavailable.observe({ toolCallId: "u", toolName: "write", args: { CMD: "ls" } });
  await unavailable.drain();

  assert.deepEqual(evidence.map((entry) => entry.status), ["malformed", "unavailable"]);
  assert.equal(JSON.stringify(evidence).includes("ls"), false);
});

test("the wrapper reports non-exact string shapes to the shadow hook without mutating them", async () => {
  const { createBashRouteState, wrapToolForBashRouting } = await import("../command-routing/wrapper.ts");
  const observed: Array<{ toolName: string; args: unknown }> = [];
  const builtin = {
    name: "write", label: "write", description: "builtin", parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "builtin ran" }] }),
  };
  const state = createBashRouteState({ isEnabled: () => true, isTrusted: () => true });
  const wrapper = wrapToolForBashRouting({
    builtin: builtin as never, toolName: "write", state,
    delegate: async () => { throw new Error("bash must not run"); },
    resolveBuiltin: () => builtin as never,
    nextToken: () => "tok",
    onNonExactShape: (info) => observed.push(info),
  });

  const args = { CMD: "git status", depth: 3 };
  const snapshot = JSON.stringify(args);
  const prepared = wrapper.prepareArguments!(args);

  assert.deepEqual(prepared, args, "non-exact arguments are returned unchanged");
  assert.equal(JSON.stringify(args), snapshot, "arguments are never mutated");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.toolName, "write");
  assert.equal(JSON.stringify(observed[0]!.args), snapshot);

  // An exact bash shape takes the deterministic route and is not shadowed as non-exact.
  observed.length = 0;
  const sentinel = wrapper.prepareArguments!({ command: "git status" });
  assert.equal(JSON.stringify(sentinel).includes("git status"), false);
  assert.equal(observed.length, 0, "the exact route does not report a non-exact shape");
});

test("the runtime owns the mapping shadow only with shadow consent and a client", async () => {
  const { createRuntime, resetSessionState } = await import("../runtime.ts");
  const client = { choose: async () => ({ answers: { mapping: { type: "choice", choice: "none", probabilities: { none: 1 } } } }) };

  assert.equal(createRuntime({ jevClient: client as never }).mappingShadow, undefined, "off without shadow consent");
  const withConsent = createRuntime({ jevClient: client as never, sourceShadowingEnabled: true });
  assert.ok(withConsent.mappingShadow, "created with consent and a client");
  const enumeration = withConsent.mappingShadow!.observe({ toolCallId: "c", toolName: "write", args: { CMD: "ls" } });
  assert.equal(enumeration.status, "candidates");
  await withConsent.mappingShadow!.drain();

  resetSessionState(withConsent);
  assert.ok(withConsent.mappingShadow, "recreated on session reset");
});
