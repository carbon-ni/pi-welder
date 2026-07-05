import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectToolCallMistakes,
  collectToolResultMistake,
  emptyTelemetry,
  recordMistake,
  summarizeTelemetry,
} from "./tool-mistakes.ts";

test("collectToolCallMistakes: valid built-in call has no mistakes", () => {
  assert.deepEqual(collectToolCallMistakes({ toolName: "read", input: { path: "/tmp/a" } }), []);
});

test("collectToolCallMistakes: detects aliased field names", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "read", input: { file_path: "/tmp/a" } });
  assert.equal(mistake?.kind, "schema");
  assert.equal(mistake?.pattern, "aliased_field");
  assert.equal(mistake?.field, "path");
  assert.equal(mistake?.receivedField, "file_path");
});

test("collectToolCallMistakes: detects null optional fields", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "read", input: { path: "/tmp/a", offset: null } });
  assert.equal(mistake?.pattern, "null_optional");
  assert.equal(mistake?.field, "offset");
});

test("collectToolCallMistakes: detects empty object placeholders for arrays", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "grep", input: { pattern: "x", include: {} } });
  assert.equal(mistake?.pattern, "empty_object_placeholder");
  assert.equal(mistake?.field, "include");
});

test("collectToolCallMistakes: detects JSON-stringified arrays", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "grep", input: { pattern: "x", include: '["src"]' } });
  assert.equal(mistake?.pattern, "stringified_array");
  assert.equal(mistake?.field, "include");
});

test("collectToolCallMistakes: detects bare string where array expected", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "grep", input: { pattern: "x", include: "src" } });
  assert.equal(mistake?.pattern, "bare_string_array");
  assert.equal(mistake?.field, "include");
});

test("collectToolCallMistakes: detects bare string root input", () => {
  const [mistake] = collectToolCallMistakes({ toolName: "read", input: "/tmp/a" });
  assert.equal(mistake?.kind, "syntax");
  assert.equal(mistake?.pattern, "bare_string_root");
  assert.equal(mistake?.field, "path");
});

test("collectToolCallMistakes: ignores unknown tools until schemas are known", () => {
  assert.deepEqual(collectToolCallMistakes({ toolName: "unknown", input: { x: 1 } }), []);
});

test("collectToolResultMistake: excludes bash CLI failures with exitCode", () => {
  assert.equal(collectToolResultMistake({ toolName: "bash", isError: true, details: { exitCode: 2 }, content: [{ type: "text", text: "bad cli" }] }), null);
});

test("collectToolResultMistake: records harness-side tool result errors", () => {
  const mistake = collectToolResultMistake({ toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] });
  assert.equal(mistake?.kind, "harness");
  assert.equal(mistake?.pattern, "tool_result_error");
});

test("recordMistake: appends immutable records with model and repair metadata", () => {
  const now = () => "2026-07-05T10:00:00.000Z";
  const log = emptyTelemetry();
  const [draft] = collectToolCallMistakes({ toolName: "read", input: "/tmp/a" });
  const next = recordMistake(log, {
    ...draft!,
    toolCallId: "c1",
    cwd: "/repo",
    modelId: "glm-5",
    repaired: true,
    repairRules: ["wrapRootStringAsObject"],
  }, now);
  assert.equal(log.records.length, 0);
  assert.equal(next.records[0]?.id, 1);
  assert.equal(next.records[0]?.modelId, "glm-5");
  assert.equal(next.records[0]?.repaired, true);
  assert.deepEqual(next.records[0]?.repairRules, ["wrapRootStringAsObject"]);
  assert.equal(next.nextId, 2);
});

test("summarizeTelemetry: groups hotspots by model/tool/pattern with repair counts", () => {
  const now = () => "2026-07-05T10:00:00.000Z";
  let telemetry = emptyTelemetry();
  telemetry = recordMistake(telemetry, { kind: "syntax", phase: "tool_call", pattern: "bare_string_root", toolName: "read", toolCallId: "c1", cwd: "/", input: "/a", modelId: "glm", repaired: true, repairRules: ["wrapRootStringAsObject"] }, now);
  telemetry = recordMistake(telemetry, { kind: "syntax", phase: "tool_call", pattern: "bare_string_root", toolName: "read", toolCallId: "c2", cwd: "/", input: "/b", modelId: "glm", repaired: false }, now);
  const summary = summarizeTelemetry(telemetry);
  assert.match(summary, /2 model tool-call mistakes/);
  assert.match(summary, /glm read bare_string_root: 2 \(repaired 1\)/);
});
