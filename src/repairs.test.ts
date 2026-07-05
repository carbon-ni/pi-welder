import { test } from "node:test";
import assert from "node:assert/strict";

import {
  repairArgs,
  objectRepairRules,
  unwrapMarkdownLink,
  tryParseJsonString,
  coerceToBoolean,
  coerceToNumber,
  isNullLikeString,
  trySplitStringToArray,
  applyRelationalDefaults,
  repairRules,
  type RepairAction,
  type RepairRule,
} from "./repairs.ts";

const noRepairs = (input: Record<string, unknown>) => repairArgs(input).repairs;

// ─── Passthrough: valid input is never mutated ───────────────────────────

test("valid input passes through unchanged with no repairs", () => {
  const input = { path: "src/index.ts", limit: 10, offset: 1, edits: [{ oldText: "a", newText: "b" }] };
  const { result, repairs } = repairArgs(input);
  assert.deepEqual(result, input);
  assert.equal(repairs.length, 0);
});

test("empty object produces no repairs", () => {
  const { result, repairs } = repairArgs({});
  assert.deepEqual(result, {});
  assert.equal(repairs.length, 0);
});

// ─── strip-null: null optional fields are omitted ────────────────────────

test("strips null from non-content fields", () => {
  const { result, repairs } = repairArgs({ path: "a.ts", limit: null, offset: null });
  assert.deepEqual(result, { path: "a.ts" });
  assert.deepEqual(repairs.map((r) => r.action), ["strip-null", "strip-null"]);
});

test("does not strip null from content fields — coerces to empty string", () => {
  const { result } = repairArgs({ path: "a.ts", oldText: null, newText: null });
  assert.deepEqual(result, { path: "a.ts", oldText: "", newText: "" });
});

// ─── strip-null-like: "null"/"none"/"n/a" strings omitted ────────────────

test("strips null-like strings from non-content fields", () => {
  for (const bad of ["null", "none", "n/a", "NA", " undefined "]) {
    const { result } = repairArgs({ path: "a.ts", target: bad });
    assert.deepEqual(result, { path: "a.ts" }, `expected ${bad} stripped`);
  }
});

test("does not strip null-like strings from content fields", () => {
  const { result, repairs } = repairArgs({ note: "none", body: "null" });
  assert.deepEqual(result, { note: "none", body: "null" });
  assert.equal(repairs.length, 0);
});

// ─── clean-path: markdown link unwrapping ───────────────────────────────

test("unwraps markdown auto-links from path fields", () => {
  const { result, repairs } = repairArgs({ path: "[notes.md](http://notes.md)" });
  assert.equal(result.path, "notes.md");
  assert.ok(repairs.some((r) => r.action === "clean-path"));
});

test("leaves real markdown links untouched", () => {
  const { result, repairs } = repairArgs({ path: "[click here](https://x.com)" });
  assert.equal(result.path, "[click here](https://x.com)");
  assert.equal(repairs.length, 0);
});

test("trims whitespace on path fields", () => {
  const { result } = repairArgs({ path: "  src/a.ts  " });
  assert.equal(result.path, "src/a.ts");
});

// ─── parse-json: stringified JSON arrays/objects ────────────────────────

test("parses stringified JSON arrays", () => {
  const { result, repairs } = repairArgs({ paths: '["a.ts","b.ts"]' });
  assert.deepEqual(result.paths, ["a.ts", "b.ts"]);
  assert.ok(repairs.some((r) => r.action === "parse-json"));
});

test("parses stringified JSON objects", () => {
  const { result } = repairArgs({ options: '{"a":1,"b":2}' });
  assert.deepEqual(result.options, { a: 1, b: 2 });
});

test("does not parse non-JSON strings", () => {
  const { result, repairs } = repairArgs({ name: "just a name" });
  assert.equal(result.name, "just a name");
  assert.equal(repairs.length, 0);
});

test("does not parse invalid JSON", () => {
  const { result, repairs } = repairArgs({ paths: "[not valid" });
  assert.equal(result.paths, "[not valid");
  assert.equal(repairs.length, 0);
});

// ─── wrap-array: bare scalar → single-element array ─────────────────────

test("wraps bare string into array for array fields", () => {
  const { result, repairs } = repairArgs({ function_names: "main" });
  assert.deepEqual(result.function_names, ["main"]);
  assert.ok(repairs.some((r) => r.action === "wrap-array"));
});

test("wraps bare number into array for array fields", () => {
  const { result } = repairArgs({ ids: 42 });
  assert.deepEqual(result.ids, [42]);
});

test("does not wrap already-array values", () => {
  const { result, repairs } = repairArgs({ paths: ["a.ts", "b.ts"] });
  assert.deepEqual(result.paths, ["a.ts", "b.ts"]);
  assert.equal(repairs.length, 0);
});

// ─── wrap-object-array: bare object → [object] ──────────────────────────

test("wraps bare object into single-element array for array fields", () => {
  const { result, repairs } = repairArgs({ edits: { oldText: "a", newText: "b" } });
  assert.deepEqual(result.edits, [{ oldText: "a", newText: "b" }]);
  assert.ok(repairs.some((r) => r.action === "wrap-object-array"));
});

// ─── split-string: delimited strings → array ────────────────────────────

test("splits comma-separated string into array", () => {
  const { result, repairs } = repairArgs({ tags: "admin, user" });
  assert.deepEqual(result.tags, ["admin", "user"]);
  assert.ok(repairs.some((r) => r.action === "split-string"));
});

test("does not split path-like strings (wraps them instead)", () => {
  const { result, repairs } = repairArgs({ tags: "src/a.ts" });
  assert.deepEqual(result.tags, ["src/a.ts"]);
  assert.ok(!repairs.some((r) => r.action === "split-string"));
});

test("does not split JSON-like strings", () => {
  const { result } = repairArgs({ names: '["a","b"]' });
  assert.deepEqual(result.names, ["a", "b"]); // parse-json handles it, not split
});

// ─── coerce-boolean ─────────────────────────────────────────────────────

test("coerces boolean strings for boolean fields", () => {
  const cases: Array<[unknown, boolean]> = [
    ["true", true], ["yes", true], ["on", true], ["1", true],
    ["false", false], ["no", false], ["off", false], ["0", false],
  ];
  for (const [input, expected] of cases) {
    const { result } = repairArgs({ strict: input });
    assert.equal(result.strict, expected, `expected ${String(input)} → ${expected}`);
  }
});

test("does not coerce non-boolean strings", () => {
  const { result, repairs } = repairArgs({ strict: "maybe" });
  assert.equal(result.strict, "maybe");
  assert.equal(repairs.length, 0);
});

// ─── coerce-number ──────────────────────────────────────────────────────

test("coerces numeric strings for number fields", () => {
  const cases: Array<[unknown, number]> = [["42", 42], ["-3", -3], ["3.14", 3.14], ["0.5", 0.5]];
  for (const [input, expected] of cases) {
    const { result } = repairArgs({ limit: input });
    assert.equal(result.limit, expected, `expected ${String(input)} → ${expected}`);
  }
});

test("does not coerce ambiguous number strings", () => {
  const { result, repairs } = repairArgs({ port: "42px" });
  assert.equal(result.port, "42px");
  assert.ok(!repairs.some((r) => r.action === "coerce-number"));
});

// ─── strip-extra-props: array item schema enforcement ───────────────────

test("strips disallowed props from edits array items", () => {
  const { result, repairs } = repairArgs({
    edits: [{ oldText: "a", newText: "b", path: "/x" }],
  });
  assert.deepEqual(result.edits, [{ oldText: "a", newText: "b" }]);
  assert.ok(repairs.some((r) => r.action === "strip-extra-props"));
});

test("leaves valid edits items untouched", () => {
  const { result, repairs } = repairArgs({ edits: [{ oldText: "a", newText: "b" }] });
  assert.deepEqual(result.edits, [{ oldText: "a", newText: "b" }]);
  assert.equal(repairs.length, 0);
});

// ─── relational defaults ────────────────────────────────────────────────

test("injects offset when only limit is present", () => {
  const { result, repairs } = applyRelationalDefaults({ limit: 30 });
  assert.deepEqual(result, { limit: 30, offset: 1 });
  assert.ok(repairs.some((r) => r.action === "relational-default"));
});

test("injects limit when only offset is present", () => {
  const { result } = applyRelationalDefaults({ offset: 5 });
  assert.deepEqual(result, { offset: 5, limit: 2000 });
});

test("does not inject defaults when both present", () => {
  const { result, repairs } = applyRelationalDefaults({ limit: 10, offset: 2 });
  assert.deepEqual(result, { limit: 10, offset: 2 });
  assert.equal(repairs.length, 0);
});

test("repairArgs applies relational defaults end-to-end", () => {
  const { result } = repairArgs({ path: "a.ts", limit: 50 });
  assert.equal(result.offset, 1);
});

test("default object repair rules are explicit and immutable", () => {
  assert.deepEqual(objectRepairRules.map((rule) => rule.action), ["relational-default"]);
  assert.equal(Object.isFrozen(objectRepairRules), true);
});

test("custom object repair rules can extend top-level defaults", () => {
  const { result, repairs } = repairArgs(
    { query: "modularity" },
    {
      extraObjectRules: [{
        action: "relational-default",
        repair(input) {
          if (!("query" in input) || "limit" in input) return { result: input, repairs: [] };
          return {
            result: { ...input, limit: 10 },
            repairs: [{ field: "input.limit", action: "relational-default" }],
          };
        },
      }],
    },
  );

  assert.deepEqual(result, { query: "modularity", limit: 10, offset: 1 });
  assert.deepEqual(repairs.map((r) => r.action), ["relational-default", "relational-default"]);
});

// ─── recursion: nested objects and arrays ───────────────────────────────

test("recurses into nested objects", () => {
  const { result } = repairArgs({ config: { strict: "true" } });
  assert.equal((result.config as { strict: boolean }).strict, true);
});

test("nested content fields keep content-field safety", () => {
  const { result, repairs } = repairArgs({ payload: { command: null, limit: null } });
  assert.deepEqual(result, { payload: { command: "" } });
  assert.deepEqual(repairs.map((r) => r.action), ["strip-null"]);
});

test("recurses into array items", () => {
  const { result } = repairArgs({
    tasks: [{ count: "3" }],
  });
  assert.deepEqual(result.tasks, [{ count: 3 }]);
});

// ─── unit helpers ───────────────────────────────────────────────────────

test("unwrapMarkdownLink: degenerate auto-links only", () => {
  assert.equal(unwrapMarkdownLink("[notes.md](http://notes.md)"), "notes.md");
  assert.equal(unwrapMarkdownLink("[file.ts](file.ts)"), "file.ts");
  assert.equal(unwrapMarkdownLink("[label](https://site.com)"), "[label](https://site.com)");
  assert.equal(unwrapMarkdownLink("plain.ts"), "plain.ts");
});

test("tryParseJsonString: only array/object payloads", () => {
  assert.deepEqual(tryParseJsonString('["a","b"]'), ["a", "b"]);
  assert.deepEqual(tryParseJsonString('{"x":1}'), { x: 1 });
  assert.equal(tryParseJsonString("plain"), "plain");
  assert.equal(tryParseJsonString("[broken"), "[broken");
});

test("coerceToBoolean: truthy/falsy spellings", () => {
  assert.equal(coerceToBoolean("true"), true);
  assert.equal(coerceToBoolean("NO"), false);
  assert.equal(coerceToBoolean("maybe"), "maybe");
  assert.equal(coerceToBoolean(true), true);
});

test("coerceToNumber: clearly-numeric only", () => {
  assert.equal(coerceToNumber("42"), 42);
  assert.equal(coerceToNumber("-3.14"), -3.14);
  assert.equal(coerceToNumber("42px"), "42px");
  assert.equal(coerceToNumber(7), 7);
});

test("isNullLikeString: known null-like spellings", () => {
  assert.equal(isNullLikeString("null"), true);
  assert.equal(isNullLikeString(" N/A "), true);
  assert.equal(isNullLikeString("hello"), false);
  assert.equal(isNullLikeString(0), false);
});

test("trySplitStringToArray: comma + space, not paths", () => {
  assert.deepEqual(trySplitStringToArray("a, b, c"), ["a", "b", "c"]);
  assert.deepEqual(trySplitStringToArray("foo bar"), ["foo", "bar"]);
  assert.equal(trySplitStringToArray("src/a.ts"), "src/a.ts");
  assert.equal(trySplitStringToArray(42), 42);
});

// ─── content-field safety across the board ──────────────────────────────

test("never repairs command content even if it looks numeric or null-ish", () => {
  const { result, repairs } = repairArgs({ command: "echo 42", code: "null != nil" });
  assert.equal(result.command, "echo 42");
  assert.equal(result.code, "null != nil");
  assert.equal(repairs.length, 0);
});

test("repair rule order is explicit", () => {
  assert.deepEqual(repairRules.map((rule) => rule.action), [
    "clean-path",
    "parse-json",
    "array-shape",
    "coerce-boolean",
    "coerce-number",
    "strip-extra-props",
  ]);
});

test("default repair rules are immutable", () => {
  assert.equal(Object.isFrozen(repairRules), true);
});

test("custom repair rules can extend default repairs", () => {
  const markSearchTarget: RepairRule = {
    action: "clean-path",
    repair(value, ctx) {
      if (ctx.toolName !== "search" || ctx.key !== "target" || typeof value !== "string") {
        return { value, repairs: [] };
      }
      return { value: value.toUpperCase(), repairs: [{ field: ctx.fieldPath, action: "clean-path" }] };
    },
  };

  const { result, repairs } = repairArgs(
    { path: " src/a.ts ", target: "abc" },
    { toolName: "search", extraRules: [markSearchTarget] },
  );

  assert.deepEqual(result, { path: "src/a.ts", target: "ABC" });
  assert.deepEqual(repairs.map((r) => r.action), ["clean-path", "clean-path"]);
});

test("repair rules receive tool context for tool-specific fixes", () => {
  const uppercaseTargetForSearch: RepairRule = {
    action: "clean-path",
    repair(value, ctx) {
      if (ctx.toolName !== "search" || ctx.key !== "target" || typeof value !== "string") {
        return { value, repairs: [] };
      }
      return { value: value.toUpperCase(), repairs: [{ field: ctx.fieldPath, action: "clean-path" }] };
    },
  };

  const { result, repairs } = repairArgs(
    { target: "abc" },
    { toolName: "search", rules: [uppercaseTargetForSearch] },
  );

  assert.deepEqual(result, { target: "ABC" });
  assert.deepEqual(repairs, [{ field: "input.target", action: "clean-path" }]);
});

test("all repair actions are documented spellings", () => {
  const allowed: RepairAction[] = [
    "strip-null", "strip-null-like", "clean-path", "parse-json",
    "wrap-array", "wrap-object-array", "split-string",
    "coerce-boolean", "coerce-number", "strip-extra-props",
    "relational-default",
  ];
  const { repairs } = repairArgs({
    path: null, limit: null, target: "none", names: "[\"a\"]",
    edits: { oldText: "x", newText: "y" }, ids: 5, tags: "a, b",
    strict: "true", timeout: "30", commands: [{ label: "l", command: "c", extra: 1 }],
  });
  for (const r of repairs) {
    assert.ok(allowed.includes(r.action), `unknown action ${r.action}`);
  }
  assert.ok(noRepairs({ a: 1 }).length === 0);
});
