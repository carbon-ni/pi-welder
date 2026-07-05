import { test } from "node:test";
import assert from "node:assert/strict";
import { repairToolCallInput } from "./tool-repair.ts";

test("repairToolCallInput: valid input is unchanged", () => {
  const input = { path: "/tmp/a" };
  const result = repairToolCallInput({ toolName: "read", input });
  assert.equal(result.changed, false);
  assert.equal(result.input, input);
  assert.deepEqual(result.rulesFired, []);
});

test("repairToolCallInput: renames known alias when canonical field is absent", () => {
  const result = repairToolCallInput({ toolName: "read", input: { file_path: "/tmp/a" } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { path: "/tmp/a" });
  assert.deepEqual(result.rulesFired, ["renameAliasedField"]);
});

test("repairToolCallInput: does not overwrite canonical field with alias", () => {
  const result = repairToolCallInput({ toolName: "read", input: { path: "/tmp/a", file_path: "/tmp/b" } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.input, { path: "/tmp/a", file_path: "/tmp/b" });
});

test("repairToolCallInput: drops null optional fields", () => {
  const result = repairToolCallInput({ toolName: "read", input: { path: "/tmp/a", offset: null, limit: 10 } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { path: "/tmp/a", limit: 10 });
  assert.deepEqual(result.rulesFired, ["dropNullOptional"]);
});

test("repairToolCallInput: drops empty object placeholders where arrays are expected", () => {
  const result = repairToolCallInput({ toolName: "grep", input: { pattern: "x", include: {} } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { pattern: "x" });
  assert.deepEqual(result.rulesFired, ["dropEmptyObjectPlaceholder"]);
});

test("repairToolCallInput: parses JSON-stringified arrays", () => {
  const result = repairToolCallInput({ toolName: "grep", input: { pattern: "x", include: '["src","test"]' } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { pattern: "x", include: ["src", "test"] });
  assert.deepEqual(result.rulesFired, ["parseJsonStringifiedArray"]);
});

test("repairToolCallInput: wraps bare strings where arrays are expected", () => {
  const result = repairToolCallInput({ toolName: "grep", input: { pattern: "x", include: "src" } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { pattern: "x", include: ["src"] });
  assert.deepEqual(result.rulesFired, ["wrapBareStringAsArray"]);
});

test("repairToolCallInput: wraps root string for known tool field", () => {
  const result = repairToolCallInput({ toolName: "read", input: "/tmp/a" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.input, { path: "/tmp/a" });
  assert.deepEqual(result.rulesFired, ["wrapRootStringAsObject"]);
});

test("repairToolCallInput: ignores unknown tools", () => {
  const input = { q: "x" };
  const result = repairToolCallInput({ toolName: "unknown", input });
  assert.equal(result.changed, false);
  assert.equal(result.input, input);
});

test("repairToolCallInput: does not apply repair if repaired input is still invalid", () => {
  const input = { file_path: 123 };
  const result = repairToolCallInput({ toolName: "read", input });
  assert.equal(result.changed, false);
  assert.equal(result.input, input);
  assert.deepEqual(result.rulesFired, []);
});

test("repairToolCallInput: does not drop required null fields", () => {
  const input = { path: null };
  const result = repairToolCallInput({ toolName: "read", input });
  assert.equal(result.changed, false);
  assert.equal(result.input, input);
});

test("repairToolCallInput: does not mutate original input", () => {
  const input = { pattern: "x", include: '["src"]' };
  const result = repairToolCallInput({ toolName: "grep", input });
  assert.deepEqual(input, { pattern: "x", include: '["src"]' });
  assert.deepEqual(result.input, { pattern: "x", include: ["src"] });
});
