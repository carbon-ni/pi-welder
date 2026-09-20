import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_ORDER,
  TOOL_CONTRACTS,
  capabilityOf,
  capabilityRank,
  contractFor,
  isCapabilityEscalation,
  isRoutingAllowed,
  registryConsistentWithRuntime,
} from "./contracts.ts";
import {
  candidateMatches,
  classifyMatch,
  declaredKeysOf,
  deterministicChoice,
  isValidationFailure,
  narrowByDeclaredKeys,
  piValidationTool,
  primaryCandidates,
  rankCandidates,
  schemaMatch,
  shapeOf,
  type ToolMatch,
} from "./match.ts";
import { extractRoutingEpisodes, type RoutingEvent } from "./episode.ts";
import { parseRoutingSessionText } from "./session.ts";
import {
  ROUTING_PROMOTION_GATE,
  buildRoutingRequest,
  decideRouting,
  deterministicChoiceFor,
  evaluateRouting,
  parseRoutingResponse,
  routingOptions,
  routingRequestPrivacyPasses,
  type RoutingMetrics,
  type RoutingOutcome,
} from "./evaluation.ts";

test("the contract registry matches the runtime schema and its capability order", () => {
  assert.equal(registryConsistentWithRuntime(), true);
  for (const tool of ["read", "write", "edit", "bash"]) assert.ok(TOOL_CONTRACTS.has(tool));
  assert.deepEqual(contractFor("read")!.required, ["path"]);
  assert.deepEqual(contractFor("read")!.optional, ["offset", "limit"]);
  assert.deepEqual(contractFor("write")!.required, ["path", "content"]);
  assert.deepEqual(contractFor("edit")!.required, ["path", "edits"]);
  assert.deepEqual(contractFor("bash")!.required, ["command"]);
  assert.deepEqual(contractFor("bash")!.optional, ["timeout"]);
  assert.deepEqual(CAPABILITY_ORDER, ["read-only", "filesystem-mutation", "process-execution", "external-side-effect"]);
  assert.equal(capabilityRank("read-only") < capabilityRank("filesystem-mutation"), true);
  assert.equal(capabilityRank("filesystem-mutation") < capabilityRank("process-execution"), true);
  assert.equal(capabilityRank("process-execution") < capabilityRank("external-side-effect"), true);
});

test("capability escalation is blocked; equal or lower capability is allowed", () => {
  assert.equal(isCapabilityEscalation("read", "read-only"), false);
  assert.equal(isCapabilityEscalation("write", "read-only"), false, "mutation to read is a downgrade");
  assert.equal(isCapabilityEscalation("read", "filesystem-mutation"), true);
  assert.equal(isCapabilityEscalation("write", "process-execution"), true);
  assert.equal(isCapabilityEscalation("bash", "process-execution"), false);
  assert.equal(isCapabilityEscalation("bash", "external-side-effect"), true);
  assert.equal(isCapabilityEscalation("send_to_session", "read-only"), false);
  assert.equal(isCapabilityEscalation("unknown_tool", "read-only"), true, "unknown source is never assumed safe");
  assert.equal(isRoutingAllowed("edit", "filesystem-mutation"), true);
  assert.equal(isRoutingAllowed("edit", "process-execution"), false);
  assert.equal(capabilityOf("unknown_tool"), undefined);
});

test("argument shapes match required, optional, unknown, and typed keys deterministically", () => {
  assert.equal(schemaMatch(contractFor("bash")!, shapeOf({ command: "x", timeout: 1 })), "exact");
  assert.equal(schemaMatch(contractFor("bash")!, shapeOf({ command: "x" })), "exact", "optional timeout may be absent");
  assert.equal(schemaMatch(contractFor("bash")!, shapeOf({ command: 1 })), "reject", "wrong type");
  assert.equal(schemaMatch(contractFor("bash")!, shapeOf({ command: "x", path: "p" })), "reject", "unknown key");
  assert.equal(schemaMatch(contractFor("bash")!, shapeOf({ timeout: 1 })), "compatible", "required key missing");
  assert.equal(schemaMatch(contractFor("write")!, shapeOf({ path: "p", content: "c" })), "exact");
  assert.equal(schemaMatch(contractFor("write")!, shapeOf({ path: "p" })), "compatible");
  assert.equal(schemaMatch(contractFor("read")!, shapeOf({ path: "p", offset: 1, limit: 2 })), "exact");
});

test("a write call carrying bash's command/timeout shape has exactly one exact candidate", () => {
  const shape = shapeOf({ command: "ls", timeout: 1000 });
  const matches = candidateMatches("write", shape);
  assert.deepEqual(matches.map((match) => match.tool), ["bash"]);
  assert.equal(classifyMatch(matches), "unique-exact");
  assert.equal(deterministicChoice(matches), "bash");
  // write is filesystem mutation, bash is process execution: the unique schema
  // match is still a capability escalation and must remain blocked.
  assert.equal(matches[0]!.capability, "process-execution");
  assert.equal(matches[0]!.routingAllowed, false);
  assert.equal(isRoutingAllowed("write", matches[0]!.capability), false);
  assert.deepEqual(candidateMatches("bash", shape), [], "the source tool is excluded");
});

test("matching classifies unique, ambiguous, and no-candidate sets", () => {
  assert.equal(classifyMatch(candidateMatches("edit", shapeOf({ path: "p" }))), "unique-exact", "read accepts path alone");
  assert.equal(classifyMatch(candidateMatches("bash", shapeOf({ path: "p" }))), "unique-exact");

  const empty = candidateMatches("read", shapeOf({}));
  assert.deepEqual(empty.map((match) => match.tool).sort(), ["bash", "edit", "write"]);
  assert.equal(classifyMatch(empty), "ambiguous", "no exact match, several compatible tools");
  assert.equal(primaryCandidates(empty).every((match) => !match.exact), true);

  assert.equal(classifyMatch(candidateMatches("write", shapeOf({ command: 1 }))), "none");
  assert.equal(classifyMatch([]), "none");
});

test("declared missing keys narrow candidates without emptying the set", () => {
  const empty = candidateMatches("read", shapeOf({}));
  const byPath = narrowByDeclaredKeys(empty, ["path"]);
  assert.deepEqual(byPath.map((match) => match.tool).sort(), ["edit", "write"]);
  const byCommand = narrowByDeclaredKeys(empty, ["command"]);
  assert.deepEqual(byCommand.map((match) => match.tool), ["bash"]);
  assert.equal(classifyMatch(byCommand), "unique-incomplete");
  assert.deepEqual(narrowByDeclaredKeys(empty, ["edits"]).map((match) => match.tool), ["edit"]);
  assert.deepEqual(narrowByDeclaredKeys(empty, []).length, 3);
  assert.deepEqual(narrowByDeclaredKeys(empty, ["unrelated"]).length, 3, "unknown declared key must not empty the set");
});

test("candidate ranking is deterministic", () => {
  const empty = candidateMatches("read", shapeOf({}));
  const ranked = rankCandidates(empty);
  assert.deepEqual(ranked.map((match) => match.tool), ["edit", "write", "bash"], "fewest optional keys first, then name");
  assert.deepEqual(rankCandidates(empty).map((match) => match.tool), ranked.map((match) => match.tool));
});

test("validation failure class and declared-key extraction are closed", () => {
  assert.equal(isValidationFailure("Missing required field: edits."), true);
  assert.equal(isValidationFailure("Invalid parameter type for edits; expected array."), true);
  assert.equal(isValidationFailure("Unknown field: command"), true);
  assert.equal(isValidationFailure("Funzzy RPC error -32602: invalid_options page mode"), true);
  // Command output and test names must never be mined as tool-validation failures.
  assert.equal(isValidationFailure("TAP version 13\n# Subtest: validates a well-formed graph\nok 1 - validates a well-formed graph"), false);
  assert.equal(isValidationFailure("Success: 7 Failed: 0\nexpected string but got number"), false);
  assert.equal(isValidationFailure("Error: expected an array, received object"), false, "generic phrases are excluded");
  // Multiline results are command output, not tool-arg validation.
  assert.equal(isValidationFailure("error: unexpected argument '--flag' found\n\nUsage: cargo test [OPTIONS]"), false);
  assert.equal(isValidationFailure("invalid parameter\nsecond line"), false);
  assert.equal(isValidationFailure(`invalid parameter ${"x".repeat(400)}`), false, "over-long text is not a tool-arg error");

  // The real Pi header is multiline and names its tool.
  assert.equal(isValidationFailure(PI_MULTILINE_EDIT_FAILURE), true);
  assert.equal(isValidationFailure(PI_MULTILINE_EDIT_FAILURE, "edit"), true);
  assert.equal(isValidationFailure(PI_MULTILINE_EDIT_FAILURE, "write"), false, "header tool must equal the attempted tool");
  assert.equal(piValidationTool(PI_MULTILINE_EDIT_FAILURE), "edit");
  assert.equal(piValidationTool("Validation failed for tool \"write\":\n  - content: Required"), "write");
  assert.equal(piValidationTool("cargo: unexpected argument\nValidation failed for tool"), undefined, "header must be anchored");
  assert.equal(isValidationFailure("Validation failed for tool", "write"), false, "bare words are not the header");
  assert.equal(isValidationFailure("ENOENT: no such file or directory"), false);
  assert.equal(isValidationFailure("Command timed out after 120 seconds"), false);
  assert.equal(isValidationFailure(undefined), false);

  assert.deepEqual(declaredKeysOf("Missing required field: edits."), ["edits"]);
  assert.deepEqual(declaredKeysOf("Invalid parameter type for edits; expected array."), ["edits"]);
  assert.deepEqual(declaredKeysOf("Unknown field: command"), ["command"]);
  assert.deepEqual(declaredKeysOf("no keys here"), []);
});

/** Real-shaped Pi validation failure captured from a work-wire-webapp session. */
const PI_MULTILINE_EDIT_FAILURE = [
  'Validation failed for tool "edit":',
  "  - edits: must have required properties edits",
  "",
  "Received arguments:",
  "{",
  '  "path": ".tmp/reports/07-09-26/sales-drive-upload-timeout.md",',
  '  "content": "# report body with SECRET_PATH text"',
  "}",
].join("\n");

function call(id: string, toolName: string, args: Record<string, unknown>, index = 0): RoutingEvent[] {
  return [{ id: `c${index}`, ts: "t", kind: "toolCall", toolName, toolCallId: id, args }];
}
function result(id: string, isError: boolean, errorText = "", index = 0, toolName?: string): RoutingEvent[] {
  return [{ id: `r${index}`, ts: "t", kind: "toolResult", toolCallId: id, toolName, isError, ...(errorText ? { errorText } : {}) }];
}

test("mining labels the bounded equivalent successful reroute", () => {
  const events: RoutingEvent[] = [
    ...call("f1", "write", { command: "ls", timeout: 1000 }, 0),
    ...result("f1", true, "Invalid parameter type for command; expected no such field.", 0, "write"),
    ...call("s1", "bash", { command: "ls", timeout: 1000 }, 1),
    ...result("s1", false, "", 1, "bash"),
  ];
  const { episodes, attrition } = extractRoutingEpisodes("session-1", events);
  assert.equal(attrition.mined, 1);
  assert.equal(attrition.wrongToolCommandShape, 1);
  assert.equal(attrition.reroute, 1);
  assert.equal(attrition.wrongToolCommandShapeCorrect, 1);
  assert.equal(attrition.commandShapeAnySource, 1);
  assert.deepEqual(attrition.reroutePairs, { "write->bash": 1 });
  assert.equal(episodes[0]!.labelTool, "bash");
  assert.equal(episodes[0]!.labelKind, "reroute");
  assert.equal(episodes[0]!.kind, "unique-exact");
  assert.deepEqual(episodes[0]!.shape, { command: "string", timeout: "number" });
});

test("mining requires equivalent arguments and a bounded window", () => {
  const failure: RoutingEvent[] = [
    ...call("f1", "write", { command: "ls", timeout: 1000 }, 0),
    ...result("f1", true, "Missing required field: command.", 0, "write"),
  ];
  const differentKeys: RoutingEvent[] = [ ...failure, ...call("s1", "bash", { command: "ls" }, 1), ...result("s1", false, "", 1, "bash") ];
  assert.equal(extractRoutingEpisodes("s", differentKeys).attrition.equivalentSuccess, 0, "key sets must agree");

  // Same keys and types, different values: a structural match, not a value match.
  const differentValues: RoutingEvent[] = [ ...failure, ...call("s1", "bash", { command: "pwd", timeout: 2000 }, 1), ...result("s1", false, "", 1, "bash") ];
  const shapeOnly = extractRoutingEpisodes("s", differentValues).attrition;
  assert.equal(shapeOnly.equivalentSuccess, 1);
  assert.equal(shapeOnly.valueEquivalentSuccess, 0);
  assert.equal(shapeOnly.reroute, 1);
  assert.equal(shapeOnly.strictReroute, 0);
  assert.equal(extractRoutingEpisodes("s", differentValues).episodes[0]!.labelEvidence, "shape");

  // Same keys, same values: strict agreement.
  const sameValues: RoutingEvent[] = [ ...failure, ...call("s1", "bash", { command: "ls", timeout: 1000 }, 1), ...result("s1", false, "", 1, "bash") ];
  assert.equal(extractRoutingEpisodes("s", sameValues).attrition.valueEquivalentSuccess, 1);
  assert.equal(extractRoutingEpisodes("s", sameValues).attrition.strictReroute, 1);

  const sameTool: RoutingEvent[] = [ ...failure, ...call("s1", "write", { command: "ls", timeout: 1000 }, 1), ...result("s1", false, "", 1, "write") ];
  assert.equal(extractRoutingEpisodes("s", sameTool).attrition.retry, 1, "same tool is a retry, not a reroute");
  assert.equal(extractRoutingEpisodes("s", sameTool).attrition.reroute, 0);

  const tooFar: RoutingEvent[] = [
    ...failure,
    ...call("p1", "read", { path: "a" }, 1), ...result("p1", false, "", 1, "read"),
    ...call("p2", "read", { path: "b" }, 2), ...result("p2", false, "x", 2, "read"),
    ...call("p3", "read", { path: "c" }, 3), ...result("p3", false, "x", 3, "read"),
    ...call("s1", "bash", { command: "ls", timeout: 1000 }, 4), ...result("s1", false, "", 4, "bash"),
  ];
  assert.equal(extractRoutingEpisodes("s", tooFar).attrition.equivalentSuccess, 0, "outside the three-call window");

  const userStops: RoutingEvent[] = [ ...failure, { id: "u", ts: "t", kind: "user" }, ...call("s1", "bash", { command: "ls", timeout: 1000 }, 1), ...result("s1", false, "", 1, "bash") ];
  assert.equal(extractRoutingEpisodes("s", userStops).attrition.equivalentSuccess, 0, "user event stops the search");
});

test("mining ignores non-validation failures and empty argument shapes", () => {
  const nonValidation: RoutingEvent[] = [ ...call("f1", "bash", { command: "x" }, 0), ...result("f1", true, "Command exited with code 1", 0, "bash") ];
  const { attrition } = extractRoutingEpisodes("s", nonValidation);
  assert.equal(attrition.mined, 0);
  const emptyArgs: RoutingEvent[] = [ ...call("f1", "write", {}, 0), ...result("f1", true, "Missing required field: path.", 0, "write") ];
  assert.equal(extractRoutingEpisodes("s", emptyArgs).attrition.shapeKnown, 0);
});

test("mining accepts the real multiline Pi header and labels the capability-equal reroute", () => {
  // edit received write's shape, then write succeeded with the same arguments.
  const events: RoutingEvent[] = [
    ...call("f1", "edit", { path: "docs/notes.md", content: "body" }, 0),
    ...result("f1", true, PI_MULTILINE_EDIT_FAILURE, 0, "edit"),
    ...call("s1", "write", { path: "docs/notes.md", content: "body" }, 1),
    ...result("s1", false, "", 1, "write"),
  ];
  const { episodes, attrition } = extractRoutingEpisodes("session-1", events);
  assert.equal(attrition.mined, 1);
  assert.equal(attrition.reroute, 1);
  assert.equal(attrition.strictReroute, 1);
  assert.equal(episodes[0]!.kind, "unique-exact");
  assert.equal(episodes[0]!.labelTool, "write");
  assert.equal(episodes[0]!.sourceTool, "edit");
  assert.equal(episodes[0]!.matches[0]!.routingAllowed, true, "edit -> write stays within filesystem mutation");
  assert.deepEqual(episodes[0]!.shape, { content: "string", path: "string" });
  assert.deepEqual(episodes[0]!.declaredKeys, []);
});

test("mining reads the failed call's own arguments, not the rendered Received arguments", () => {
  const mismatch = 'Validation failed for tool "write":\n  - content: Required\n\nReceived arguments:\n{\n  "command": "ls"\n}';
  const events: RoutingEvent[] = [
    ...call("f1", "write", { command: "ls", timeout: 1000 }, 0),
    ...result("f1", true, mismatch, 0, "write"),
  ];
  const episode = extractRoutingEpisodes("s", events).episodes[0]!;
  assert.deepEqual(episode.shape, { command: "string", timeout: "number" }, "shape comes from the tool call input");
  assert.equal(episode.kind, "unique-exact", "bash uniquely accepts the command/timeout shape");
  assert.equal(episode.matches[0]!.tool, "bash");
  assert.equal(episode.matches[0]!.routingAllowed, false, "write -> bash is a capability escalation and stays blocked");
});

test("CLI stderr and mismatched headers are never mined as tool-arg validation", () => {
  const cargo = "error: unexpected argument '--no-docker' found\n\nUsage: tree-sitter build\n  tip: a similar argument exists";
  const vitest = "\n RUN  v4.1.5 /repo\n\n ❯ bin/smoke.test.ts (34 tests | 7 failed)\n   × invalid parameter NAME";
  const mismatched = 'Validation failed for tool "read":\n  - path: Required';

  const cargoEvents: RoutingEvent[] = [ ...call("f1", "bash", { command: "tree-sitter build", timeout: 1000 }, 0), ...result("f1", true, cargo, 0, "bash") ];
  assert.equal(extractRoutingEpisodes("s", cargoEvents).attrition.mined, 0, "cargo stderr is not a tool-arg error");

  const vitestEvents: RoutingEvent[] = [ ...call("f1", "bash", { command: "vitest run", timeout: 1000 }, 0), ...result("f1", true, vitest, 0, "bash") ];
  assert.equal(extractRoutingEpisodes("s", vitestEvents).attrition.mined, 0, "vitest output is not a tool-arg error");

  const mismatchedEvents: RoutingEvent[] = [ ...call("f1", "bash", { command: "ls", timeout: 1000 }, 0), ...result("f1", true, mismatched, 0, "bash") ];
  assert.equal(extractRoutingEpisodes("s", mismatchedEvents).attrition.mined, 0, "a header naming another tool rejects the call");
});

test("the request carries only keys, types, declared keys, and candidate tool IDs", () => {
  const events: RoutingEvent[] = [
    ...call("f1", "write", { command: "SECRET_COMMAND --flag", timeout: 1000 }, 0),
    ...result("f1", true, "Invalid parameter type for command; expected no such field. Path /Users/secret/thing.ts", 0, "write"),
  ];
  const episode = extractRoutingEpisodes("session-1", events).episodes[0]!;
  const request = JSON.stringify(buildRoutingRequest(episode));
  for (const forbidden of ["SECRET_COMMAND", "--flag", "/Users/", "session-1", "expected no such field"]) {
    assert.equal(request.includes(forbidden), false, `request leaked: ${forbidden}`);
  }
  const parsed = JSON.parse(request);
  assert.deepEqual(parsed.state.argKeys, [{ key: "command", type: "string" }, { key: "timeout", type: "number" }]);
  assert.deepEqual(parsed.state.candidateTools, ["bash"]);
  assert.equal(parsed.state.failedTool, "write");
  assert.deepEqual(Object.keys(parsed.questions.tool.criteria).sort(), routingOptions(["bash"]).sort());
});

test("the structural privacy gate accepts closed requests and rejects any free-form value", () => {
  const events: RoutingEvent[] = [
    ...call("f1", "write", { command: "ls -la", timeout: 1000 }, 0),
    ...result("f1", true, "Invalid parameter type for command; expected no such field.", 0, "write"),
  ];
  const episode = extractRoutingEpisodes("session-1", events).episodes[0]!;
  const request = JSON.stringify(buildRoutingRequest(episode));
  assert.equal(routingRequestPrivacyPasses([request]), true);

  // Injecting a raw value anywhere fails structurally or on identifier bounds.
  const injected = JSON.parse(request);
  injected.state.argKeys[0].key = "/Users/secret/file.ts";
  assert.equal(routingRequestPrivacyPasses([JSON.stringify(injected)]), false, "free-form key rejected");

  const extraField = JSON.parse(request);
  extraField.state.command = "ls -la";
  assert.equal(routingRequestPrivacyPasses([JSON.stringify(extraField)]), false, "extra value field rejected");

  const badCriteria = JSON.parse(request);
  badCriteria.questions.tool.criteria.bash = "x".repeat(500);
  assert.equal(routingRequestPrivacyPasses([JSON.stringify(badCriteria)]), false, "unbounded criterion text rejected");

  assert.equal(routingRequestPrivacyPasses(["not json"]), false);
  assert.equal(routingRequestPrivacyPasses([]), true);
});

test("hardened parsing fails closed on unknown options and malformed probabilities", () => {
  const options = ["bash", "read", "none"];
  const probabilities = { bash: 0.9, read: 0.05, none: 0.05 };
  const valid = JSON.stringify({ answers: { tool: { type: "choice", choice: "bash", confidence: 0.9, probabilities } } });
  assert.equal(parseRoutingResponse(valid, options)?.choice, "bash");
  assert.equal(parseRoutingResponse(JSON.stringify({ answers: { tool: { type: "choice", choice: "edit", probabilities } } }), options), undefined);
  assert.equal(parseRoutingResponse(JSON.stringify({ answers: { tool: { type: "choice", choice: "bash", confidence: 2, probabilities } } }), options), undefined);
  assert.equal(parseRoutingResponse(JSON.stringify({ answers: { tool: { type: "choice", choice: "bash", probabilities: { bash: 0.9, none: 0.1 } } } }), options), undefined, "missing key");
  assert.equal(parseRoutingResponse(JSON.stringify({ answers: { tool: { type: "choice", choice: "bash", probabilities: { bash: 0.9, read: 0.2, none: 0.1 } } } }), options), undefined, "sum off");
  assert.equal(parseRoutingResponse("nope", options), undefined);
});

function episodeFixture(caseId: string, sessionId: string, kind: "unique-exact" | "ambiguous", label: string) {
  return {
    episodeId: caseId,
    sessionId,
    sourceTool: "write",
    shape: { command: "string" as const },
    declaredKeys: ["command"],
    matches: [] as ReturnType<typeof candidateMatches>,
    kind,
    labelTool: label,
    labelKind: "reroute" as const,
  };
}

test("metrics split kinds, thresholds, calibration, and the deterministic baseline", () => {
  const a = episodeFixture("a", "s1", "unique-exact", "bash");
  const b = episodeFixture("b", "s1", "ambiguous", "read");
  const c = episodeFixture("c", "s2", "unique-exact", "bash");
  const labelable = [a, b, c] as never[];
  const results: RoutingOutcome[] = [
    { caseId: "a", sessionId: "s1", kind: "unique-exact", candidates: ["bash"], expectedTool: "bash", status: "answered", choice: "bash", confidence: 0.95 },
    { caseId: "b", sessionId: "s1", kind: "ambiguous", candidates: ["read", "edit"], expectedTool: "read", status: "answered", choice: "edit", confidence: 0.99 },
    { caseId: "c", sessionId: "s2", kind: "unique-exact", candidates: ["bash"], expectedTool: "bash", status: "abstained" },
  ];
  const deterministic = new Map<string, string | undefined>([["a", "bash"], ["b", "read"], ["c", "bash"]]);
  const metrics = evaluateRouting(labelable, results, deterministic);
  assert.equal(metrics.labelable, 3);
  assert.equal(metrics.byKind["unique-exact"], 2);
  assert.equal(metrics.byKind.ambiguous, 1);
  assert.equal(metrics.attempted, 2);
  assert.equal(metrics.correct, 1);
  assert.equal(metrics.abstained, 1);
  assert.equal(metrics.deterministicDenominator, 3);
  assert.equal(metrics.deterministicCorrect, 3);
  assert.equal(metrics.deterministicAccuracy, 1);
  const at90 = metrics.thresholds.find((entry) => entry.threshold === 0.9)!;
  assert.equal(at90.selections, 2);
  assert.equal(at90.correct, 1);
  assert.equal(at90.precision, 0.5);
  assert.equal(metrics.distinctSessions, 2);
});

test("blocked capability escalation is counted and rejects promotion", () => {
  const events: RoutingEvent[] = [
    ...call("f1", "read", { command: "x" }, 0),
    ...result("f1", true, "Unknown field: command", 0, "read"),
    ...call("s1", "bash", { command: "x" }, 1),
    ...result("s1", false, "", 1, "bash"),
  ];
  const episode = extractRoutingEpisodes("s", events).episodes[0]!;
  assert.equal(episode.sourceTool, "read");
  assert.equal(episode.kind, "unique-exact");
  const outcome: RoutingOutcome = { caseId: episode.episodeId, sessionId: "s", kind: episode.kind, candidates: ["bash"], expectedTool: "read", status: "answered", choice: "bash", confidence: 0.99 };
  const metrics = evaluateRouting([episode], [outcome], new Map([[episode.episodeId, "bash"]]));
  assert.equal(metrics.escalationBlockedChoices, 1);
  assert.equal(decideRouting(metrics).verdict, "reject");
  assert.match(decideRouting(metrics).reason, /escalation/);
});

test("the promotion gate requires volume, zero wrong, and beating the baseline", () => {
  const metrics = (overrides: Partial<RoutingMetrics> = {}): RoutingMetrics => ({
    labelable: 40, byKind: { "unique-exact": 40, "unique-incomplete": 0, ambiguous: 0, none: 0 },
    attempted: 40, correct: 40, accuracy: 1, abstained: 0, malformed: 0, failed: 0,
    thresholds: [
      { threshold: 0.9, selections: 40, correct: 40, precision: 1, coverage: 1 },
      { threshold: 0.99, selections: 40, correct: 40, precision: 1, coverage: 1 },
    ],
    calibration: [], deterministicDenominator: 40, deterministicCorrect: 20, deterministicAccuracy: 0.5,
    escalationBlockedChoices: 0, distinctSessions: 10, topSessionConcentration: [],
    ...overrides,
  });
  assert.equal(decideRouting(metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 10, precision: 0.25, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] })).verdict, "reject");
  assert.equal(decideRouting(metrics({ thresholds: [{ threshold: 0.9, selections: 40, correct: 39, precision: 0.975, coverage: 1 }, { threshold: 0.99, selections: 0, correct: 0, precision: 0, coverage: 0 }] })).verdict, "reject", "wrong selections");
  assert.equal(decideRouting(metrics({ deterministicAccuracy: 1 })).verdict, "shadow-only");
  assert.equal(decideRouting(metrics()).verdict, "promote");
  assert.deepEqual(ROUTING_PROMOTION_GATE, { minSelections: 30, threshold: 0.9, maxWrong: 0 });
});

test("the deterministic baseline choice is derived from the episode candidates", () => {
  const shape = shapeOf({ command: "x" });
  const episode = { episodeId: "e", sessionId: "s", sourceTool: "write", shape, declaredKeys: [], matches: candidateMatches("write", shape), kind: classifyMatch(candidateMatches("write", shape)), labelTool: "bash", labelKind: "reroute" as const };
  assert.equal(deterministicChoiceFor(episode), "bash");
});

test("the session parser keeps argument keys and types without values in episodes", () => {
  const lines = [
    JSON.stringify({ type: "session", id: "sess-1" }),
    JSON.stringify({ id: "m1", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { command: "ls", timeout: 5 } }] } }),
    JSON.stringify({ id: "m2", timestamp: "t", message: { role: "toolResult", toolCallId: "call-1", toolName: "write", isError: true, content: [{ type: "text", text: "Missing required field: command." }] } }),
  ].join("\n");
  const parsed = parseRoutingSessionText(lines);
  assert.equal(parsed.sessionId, "sess-1");
  assert.equal(parsed.events.length, 2);
  assert.deepEqual(parsed.events[0]!.args, { command: "ls", timeout: 5 });
  const { episodes } = extractRoutingEpisodes(parsed.sessionId, parsed.events);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.sourceTool, "write");
  assert.deepEqual(episodes[0]!.shape, { command: "string", timeout: "number" });
});
