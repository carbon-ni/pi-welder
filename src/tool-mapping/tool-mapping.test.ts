import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAPPING_PROMOTION_GATE,
  buildToolMappingRequest,
  decideMappings,
  evaluateMappings,
  featuresOfValue,
  extractPlanEpisodes,
  parseToolMappingAnswer,
  planMatchesCall,
  planMappings,
  planOptions,
  validatesMapping,
  type LabelledPlanCase,
  type MappingEvent,
  type MappingMetrics,
  type MappingOutcome,
} from "./index.ts";
import { TOOL_CONTRACTS } from "../tool-routing/contracts.ts";

test("enumerates the documented mapping examples without an alias list", () => {
  const fileName = planMappings("write", { fileName: "src/a.ts" });
  assert.equal(fileName.status, "plans");
  const readPlan = fileName.plans.find((plan) => plan.targetTool === "read")!;
  assert.deepEqual(readPlan.pairs, [{ from: "fileName", to: "path" }]);

  const write = planMappings("edit", { destination: "src/a.ts", body: "hello" });
  assert.equal(write.status, "plans");
  const writeTargets = new Set(write.plans.map((plan) => plan.targetTool));
  assert.deepEqual([...writeTargets], ["write"]);
  const intendedWrite = write.plans.find((plan) => plan.pairs.some((pair) => pair.from === "destination" && pair.to === "path"));
  assert.ok(intendedWrite, "destination -> write.path is enumerated");
  assert.deepEqual(
    intendedWrite!.pairs.map((pair) => `${pair.from}->${pair.to}`).sort(),
    ["body->content", "destination->path"],
  );
  // Both string fields are type-compatible with both write string fields, so the
  // swapped assignment is a genuine second hypothesis.
  assert.equal(write.plans.length, 2, "type-compatible swaps are real ambiguity");

  const edit = planMappings("write", { file: "src/a.ts", replacements: [{ oldText: "a", newText: "b" }] });
  assert.equal(edit.status, "plans");
  const editPlan = edit.plans.find((plan) => plan.targetTool === "edit")!;
  assert.deepEqual(editPlan.pairs, [{ from: "file", to: "path" }, { from: "replacements", to: "edits" }]);

  const bash = planMappings("read", { execute: "git status" });
  assert.equal(bash.status, "plans");
  assert.ok(bash.plans.some((plan) => plan.targetTool === "bash" && plan.pairs[0]!.to === "command"));
});

test("plans use every input field, satisfy required fields, and keep values unchanged", () => {
  const enumeration = planMappings("read", { destination: "p", body: "b" });
  assert.equal(enumeration.status, "plans");
  for (const plan of enumeration.plans) {
    assert.equal(plan.pairs.length, 2, "every input field is used");
    const target = TOOL_CONTRACTS.get(plan.targetTool)!;
    for (const required of target.required) assert.ok(required in plan.args, `${plan.targetTool}.${required}`);
    for (const pair of plan.pairs) assert.equal(plan.args[pair.to], pair.from === "destination" ? "p" : "b");
  }
  // `read` cannot take both fields, so only `write` plans are reachable.
  assert.deepEqual([...new Set(enumeration.plans.map((plan) => plan.targetTool))], ["write"]);
});

test("mappings are bijective: no value is duplicated, transformed, or dropped", () => {
  const enumeration = planMappings("edit", { a: "one", b: "two" });
  assert.equal(enumeration.status, "plans");
  for (const plan of enumeration.plans) {
    const target = TOOL_CONTRACTS.get(plan.targetTool)!;
    assert.equal(validatesMapping(target, plan.args, plan.pairs, { a: "one", b: "two" }), true);
    const assigned = plan.pairs.map((pair) => pair.to);
    assert.equal(new Set(assigned).size, assigned.length, "distinct target fields");
  }
});

test("abstains on unsupported values, too many fields, and oversized payloads", () => {
  assert.equal(planMappings("write", { command: "ls", nested: { a: 1 } }).reason, "unsupported-value");
  // Arrays only survive when the target field's own item constraint accepts them.
  const validItems = planMappings("write", { command: "ls", list: [{ oldText: "a", newText: "b" }] });
  assert.equal(validItems.status, "plans");
  assert.equal(validItems.plans.some((plan) => plan.targetTool === "edit"), true, "edit.edits accepts valid items");
  assert.equal(planMappings("write", { command: "ls", list: [1, "x", { deep: true }] }).status, "abstain", "invalid edit items are not a plan");
  assert.equal(planMappings("write", { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" }).reason, "too-many-fields");
  assert.equal(planMappings("write", { command: "x".repeat(4_000) }).reason, "oversized-value");
  assert.equal(planMappings("write", ["ls"]).reason, "not-an-object");
  assert.equal(planMappings("write", {}).reason, "no-plans");
  assert.equal(planMappings("write", { command: Number.NaN }).reason, "unsupported-value");
});

test("an exact canonical shape bypasses planning as a deterministic match", () => {
  const sourceExact = planMappings("write", { path: "a", content: "b" });
  assert.equal(sourceExact.status, "abstain");
  assert.equal(sourceExact.reason, "exact-canonical");

  // Another tool's canonical shape is also deterministic, not a hypothesis.
  const otherExact = planMappings("bash", { path: "a", content: "b" });
  assert.equal(otherExact.reason, "exact-canonical");
  assert.deepEqual(otherExact.exactTargets, ["write"]);
});

test("too many plans fail closed", () => {
  // Fixture registry: a wide string-only schema produces many permutations.
  const wide = { tool: "wide", required: ["s1", "s2", "s3"], optional: [], types: { s1: "string", s2: "string", s3: "string" }, capability: "read-only" } as const;
  const contracts = new Map([[wide.tool, wide as never]]);

  const enumeration = planMappings("write", { a: "1", b: "2", c: "3" }, { contracts: contracts as never });
  assert.equal(enumeration.status, "abstain");
  assert.equal(enumeration.reason, "too-many-plans");

  const bounded = planMappings("write", { a: "1", b: "2", c: "3" }, { contracts: contracts as never, maxPlans: 40 });
  assert.equal(bounded.status, "plans");
  assert.equal(bounded.plans.length, 6, "3! orderings");
});

test("closed value-shape features cover path, prose, code, shell, and collection", () => {
  assert.equal(featuresOfValue("/usr/local/bin/x").shape, "path");
  assert.equal(featuresOfValue("src/app/config.ts").shape, "path");
  assert.equal(featuresOfValue("git status && echo done").shape, "shell");
  assert.equal(featuresOfValue("const x = foo();").shape, "code");
  assert.equal(featuresOfValue("The user asked me to run the full test suite.").shape, "prose");
  assert.equal(featuresOfValue(["a", "b"]).shape, "collection");
  assert.equal(featuresOfValue(42).shape, "numeric");
  assert.equal(featuresOfValue(true).shape, "boolean");
  assert.equal(featuresOfValue("plain").shape, "value");

  const serialized = JSON.stringify(featuresOfValue("SECRET_VALUE --flag"));
  assert.equal(serialized.includes("SECRET_VALUE"), false, "features never carry the value");
});

test("the request carries roles, keys, closed features, and ordinals only", () => {
  const values = { destination: "SECRET_PATH/x", body: "SECRET_BODY" };
  const enumeration = planMappings("edit", values);
  assert.equal(enumeration.status, "plans");
  const request = JSON.stringify(buildToolMappingRequest("edit", enumeration.plans, values));
  for (const forbidden of ["SECRET_PATH", "SECRET_BODY"]) assert.equal(request.includes(forbidden), false, `request leaked ${forbidden}`);
  const parsed = JSON.parse(request);
  assert.equal(parsed.state.attemptedTool, "edit");
  assert.equal(parsed.state.failureClass, "schema-validation");
  assert.deepEqual(parsed.state.targets, ["write"]);
  assert.deepEqual(Object.keys(parsed.questions.plan.criteria).sort(), planOptions(enumeration.plans.length).sort());
  assert.deepEqual(parsed.state.plans[0].fields.map((field: any) => field.role).sort(), ["content", "path"]);
  assert.equal(typeof parsed.prompt, "string");
});

test("the dedicated parser is hardened and never reads another question's answer", () => {
  const options = planOptions(2);
  const probabilities = { "plan-1": 0.8, "plan-2": 0.15, none: 0.05 };
  const valid = JSON.stringify({ answers: { plan: { type: "choice", choice: "plan-1", confidence: 0.8, probabilities } } });
  const parsed = parseToolMappingAnswer(valid, options)!;
  assert.equal(parsed.planOrdinal, 1);
  assert.equal(parsed.confidence, 0.8);

  const none = JSON.stringify({ answers: { plan: { type: "choice", choice: "none", probabilities: { "plan-1": 0.1, "plan-2": 0.1, none: 0.8 } } } });
  assert.equal(parseToolMappingAnswer(none, options)!.planOrdinal, null);

  // A different question's answer shape is not accepted.
  const otherQuestion = JSON.stringify({ answers: { selection: { type: "choice", choice: 1, confidence: 0.9 } } });
  assert.equal(parseToolMappingAnswer(otherQuestion, options), undefined);
  assert.equal(parseToolMappingAnswer(JSON.stringify({ answers: { plan: { type: "choice", choice: "plan-9", probabilities } } }), options), undefined);
  assert.equal(parseToolMappingAnswer(JSON.stringify({ answers: { plan: { type: "choice", choice: "plan-1", confidence: 3, probabilities } } }), options), undefined);
  assert.equal(parseToolMappingAnswer(JSON.stringify({ answers: { plan: { type: "choice", choice: "plan-1", probabilities: { "plan-1": 0.9, none: 0.1 } } } }), options), undefined, "missing key");
  assert.equal(parseToolMappingAnswer("nope", options), undefined);
});

function call(id: string, toolName: string, args: Record<string, unknown>, index = 0): MappingEvent[] {
  return [{ id: `c${index}`, ts: "t", kind: "toolCall", toolName, toolCallId: id, args }];
}
function result(id: string, isError: boolean, errorText = "", index = 0): MappingEvent[] {
  return [{ id: `r${index}`, ts: "t", kind: "toolResult", toolCallId: id, isError, ...(errorText ? { errorText } : {}) }];
}
const validationError = (tool: string) => `Validation failed for tool "${tool}":\n  - path: must have required properties path, content\n\nReceived arguments:\n{ "execute": "git status" }`;

test("mining labels the later call that matches a plan exactly", () => {
  const events: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git status" }, 1),
    ...result("s1", false, "", 1),
  ];
  const { episodes, attrition } = extractPlanEpisodes("session-1", events);
  assert.equal(attrition.mined, 1);
  assert.equal(attrition.planned, 1);
  assert.equal(attrition.labelled, 1);
  assert.equal(episodes[0]!.targetTool, "bash");
  assert.equal(episodes[0]!.labelPlanOrdinal, episodes[0]!.plans.find((plan) => plan.targetTool === "bash")!.ordinal);
});

test("mining requires the header tool to match and a bounded exact later call", () => {
  const mismatched: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("edit"), 0),
  ];
  assert.equal(extractPlanEpisodes("s", mismatched).attrition.mined, 0);

  const wrongTarget: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "read", { path: "git status" }, 1),
    ...result("s1", false, "", 1),
  ];
  const wrongTargetEpisodes = extractPlanEpisodes("s", wrongTarget);
  assert.equal(wrongTargetEpisodes.attrition.labelled, 1, "read matches its own plan exactly");
  assert.equal(wrongTargetEpisodes.episodes[0]!.targetTool, "read");

  const changedValue: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git diff" }, 1),
    ...result("s1", false, "", 1),
  ];
  assert.equal(extractPlanEpisodes("s", changedValue).attrition.labelled, 0, "values must match unchanged");

  const tooFar: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("p1", "read", { path: "a" }, 1), ...result("p1", false, "", 1),
    ...call("p2", "read", { path: "b" }, 2), ...result("p2", false, "", 2),
    ...call("p3", "read", { path: "c" }, 3), ...result("p3", false, "", 3),
    ...call("s1", "bash", { command: "git status" }, 4), ...result("s1", false, "", 4),
  ];
  assert.equal(extractPlanEpisodes("s", tooFar).attrition.labelled, 0, "outside the three-call window");
});

test("metrics report ambiguity, tool pairs, thresholds, calibration, and baselines", () => {
  const labelable: LabelledPlanCase[] = [
    { caseId: "a", sessionId: "s1", labelPlanOrdinal: 1, planCount: 1, sourceTool: "write", targetTool: "read", baselineFirstPlan: 1, baselineIdentityOverlap: 1 },
    { caseId: "b", sessionId: "s1", labelPlanOrdinal: 2, planCount: 2, sourceTool: "write", targetTool: "bash", baselineFirstPlan: 1, baselineIdentityOverlap: 1 },
    { caseId: "c", sessionId: "s2", labelPlanOrdinal: 3, planCount: 3, sourceTool: "edit", targetTool: "write", baselineFirstPlan: 1, baselineIdentityOverlap: 3 },
  ];
  const results: MappingOutcome[] = [
    { caseId: "a", sessionId: "s1", status: "answered", planOrdinal: 1, confidence: 0.95, latencyMs: 1 },
    { caseId: "b", sessionId: "s1", status: "answered", planOrdinal: 2, confidence: 0.5, latencyMs: 1 },
    { caseId: "c", sessionId: "s2", status: "abstained", latencyMs: 1 },
  ];
  const metrics = evaluateMappings(labelable, results);
  assert.equal(metrics.labelable, 3);
  assert.equal(metrics.attempted, 2);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.accuracy, 1);
  assert.equal(metrics.abstained, 1);
  assert.deepEqual(metrics.ambiguity, { onePlan: 1, twoPlans: 1, threePlus: 1 });
  assert.deepEqual(metrics.toolPairs, { "write->read": 1, "write->bash": 1, "edit->write": 1 });
  assert.equal(metrics.baselineFirstCorrect, 1);
  assert.equal(metrics.baselineFirstAccuracy, 1 / 3);
  assert.equal(metrics.baselineIdentityCorrect, 2);
  assert.equal(metrics.baselineIdentityAccuracy, 2 / 3);
  assert.equal(metrics.distinctSessions, 2);
  const at90 = metrics.thresholds.find((entry) => entry.threshold === 0.9)!;
  assert.equal(at90.selections, 1);
  assert.equal(at90.correct, 1);
});

test("the promotion gate requires evidence, coverage, zero wrong, and beating baselines", () => {
  const metrics = (overrides: Partial<MappingMetrics> = {}): MappingMetrics => ({
    labelable: 40, attempted: 40, correct: 40, accuracy: 1, abstained: 0, malformed: 0, failed: 0, planCountMean: 2,
    ambiguity: { onePlan: 0, twoPlans: 40, threePlus: 0 }, toolPairs: {},
    thresholds: [
      { threshold: 0.9, selections: 40, correct: 40, precision: 1, coverage: 1 },
      { threshold: 0.99, selections: 40, correct: 40, precision: 1, coverage: 1 },
    ],
    calibration: [], baselineFirstCorrect: 20, baselineFirstAccuracy: 0.5, baselineIdentityCorrect: 20,
    baselineIdentityDenominator: 40, baselineIdentityAccuracy: 0.5, distinctSessions: 10, topSessionConcentration: [],
    ...overrides,
  });

  assert.equal(decideMappings(0.9, metrics(), 40).verdict, "reject", "coverage below the gate");
  assert.equal(decideMappings(0.96, metrics(), 10).verdict, "reject", "insufficient cases");
  assert.equal(decideMappings(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 29, precision: 0.725, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "too few correct");
  assert.equal(decideMappings(0.96, metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 39, precision: 0.975, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] }), 40).verdict, "reject", "wrong selection");
  assert.equal(decideMappings(0.96, metrics({ baselineIdentityAccuracy: 1 }), 40).verdict, "shadow-only", "does not beat the identity baseline");
  assert.equal(decideMappings(0.96, metrics(), 40).verdict, "promote");
  assert.deepEqual(MAPPING_PROMOTION_GATE, { minCoverage: 0.95, minSelections: 30, threshold: 0.9, maxWrong: 0 });
});

test("validatesMapping independently enforces distinct sources and distinct targets", () => {
  const write = TOOL_CONTRACTS.get("write")!;
  const input = { a: "one", b: "two" };

  const good = { path: "one", content: "two" };
  assert.equal(validatesMapping(write, good, [{ from: "a", to: "path" }, { from: "b", to: "content" }], input), true);

  // Duplicate source: one input field used twice.
  assert.equal(validatesMapping(write, good, [{ from: "a", to: "path" }, { from: "a", to: "content" }], input), false);
  // Duplicate target: two input fields collapsed onto one field.
  assert.equal(validatesMapping(write, { path: "one" }, [{ from: "a", to: "path" }, { from: "b", to: "path" }], input), false);
  // Dropped input field.
  assert.equal(validatesMapping(write, { path: "one" }, [{ from: "a", to: "path" }], input), false);
  // Value changed.
  assert.equal(validatesMapping(write, { path: "one", content: "CHANGED" }, [{ from: "a", to: "path" }, { from: "b", to: "content" }], input), false);
  // Unknown target key.
  assert.equal(validatesMapping(write, { path: "one", content: "two", extra: 1 }, [{ from: "a", to: "path" }, { from: "b", to: "content" }], input), false);
});

test("revalidation enforces the edit.edits item shape", () => {
  const edit = TOOL_CONTRACTS.get("edit")!;
  const goodItems = [{ oldText: "a", newText: "b" }];
  const pairs = [{ from: "file", to: "path" }, { from: "replacements", to: "edits" }];
  const input = { file: "p", replacements: goodItems };
  assert.equal(validatesMapping(edit, { path: "p", edits: goodItems }, pairs, input), true);

  const badShapes: unknown[] = [
    [{ oldText: "a" }],                       // missing newText
    [{ newText: "b" }],                       // missing oldText
    [{ oldText: 1, newText: "b" }],           // wrong item type
    [{ oldText: "a", newText: "b", extra: 1 }], // unknown item key
    ["plain"],                                 // not an object item
    [null],
  ];
  for (const replacements of badShapes) {
    assert.equal(
      validatesMapping(edit, { path: "p", edits: replacements }, pairs, { file: "p", replacements }),
      false,
      JSON.stringify(replacements),
    );
  }
});

test("revalidation enforces the bash timeout range", () => {
  const bash = TOOL_CONTRACTS.get("bash")!;
  const pairs = [{ from: "run", to: "command" }, { from: "wait", to: "timeout" }];
  const input = { run: "ls", wait: 10 };
  assert.equal(validatesMapping(bash, { command: "ls", timeout: 10 }, pairs, input), true);
  assert.equal(validatesMapping(bash, { command: "ls", timeout: 2_147_483.647 }, pairs, { run: "ls", wait: 2_147_483.647 }), true);
  for (const wait of [0, -1, 2_147_483.648, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.equal(
      validatesMapping(bash, { command: "ls", timeout: wait }, pairs, { run: "ls", wait }),
      false,
      `timeout ${wait}`,
    );
  }
  // An out-of-range timeout never yields a plan.
  const enumeration = planMappings("write", { run: "ls", wait: 0 });
  assert.equal(enumeration.status, "plans");
  assert.equal(enumeration.plans.some((plan) => plan.targetTool === "bash"), false, "bash plan rejected by the range constraint");
});

test("a later call may add target-valid optional fields but never unknown ones", () => {
  const events: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git status", timeout: 45 }, 1), // optional timeout added
    ...result("s1", false, "", 1),
  ];
  const accepted = extractPlanEpisodes("s", events);
  assert.equal(accepted.attrition.labelled, 1, "a target-valid optional extra is accepted");
  assert.equal(accepted.episodes[0]!.targetTool, "bash");

  const unknownExtra: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git status", mystery: 1 }, 1),
    ...result("s1", false, "", 1),
  ];
  assert.equal(extractPlanEpisodes("s", unknownExtra).attrition.labelled, 0, "an unknown extra field is rejected");

  const badExtraType: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { command: "git status", timeout: 0 }, 1),
    ...result("s1", false, "", 1),
  ];
  assert.equal(extractPlanEpisodes("s", badExtraType).attrition.labelled, 0, "an out-of-range optional extra is rejected");

  const missingRequired: MappingEvent[] = [
    ...call("f1", "write", { execute: "git status" }, 0),
    ...result("f1", true, validationError("write"), 0),
    ...call("s1", "bash", { timeout: 20 }, 1), // command missing
    ...result("s1", false, "", 1),
  ];
  assert.equal(extractPlanEpisodes("s", missingRequired).attrition.labelled, 0, "required target fields must be present");
});
