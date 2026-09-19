import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRestoreReadReason, recognizeReadShapedEdit, renderRestoredReadCall } from "./read-shape.ts";

test("recognizes the offset/limit read shape with the path passed through verbatim", () => {
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts" }), { path: "src/example.ts" });
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", offset: 10 }), { path: "src/example.ts", offset: 10 });
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", offset: 10, limit: 5 }), { path: "src/example.ts", offset: 10, limit: 5 });
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", limit: 5 }), { path: "src/example.ts", limit: 5 });
  assert.deepEqual(recognizeReadShapedEdit({ path: "./src//example.ts" }), { path: "./src//example.ts" });
});

test("recognizes the startLine/endLine read shape and converts it deterministically", () => {
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", startLine: 10, endLine: 20 }), { path: "src/example.ts", offset: 10, limit: 11 });
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", startLine: 7, endLine: 7 }), { path: "src/example.ts", offset: 7, limit: 1 });
  assert.deepEqual(recognizeReadShapedEdit({ path: "src/example.ts", startLine: 1, endLine: 1 }), { path: "src/example.ts", offset: 1, limit: 1 });
});

test("rejects mixed edit/read fields and content-bearing calls unchanged", () => {
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", edits: [{ oldText: "a", newText: "b" }], offset: 3 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", oldText: "a", newText: "b" }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", offset: 3, startLine: 3, endLine: 9 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", edits: [] }), undefined);
});

test("rejects unknown fields, missing/empty path, and malformed shapes", () => {
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", verbose: true }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "src/example.ts", offset: 1, foo: 2 }), undefined);
  assert.equal(recognizeReadShapedEdit({ offset: 1, limit: 2 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "" }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: 42 }), undefined);
  assert.equal(recognizeReadShapedEdit(null), undefined);
  assert.equal(recognizeReadShapedEdit("path"), undefined);
  assert.equal(recognizeReadShapedEdit([{ path: "a" }]), undefined);
  assert.equal(recognizeReadShapedEdit({}), undefined);
});

test("rejects invalid numeric ranges and non-integers", () => {
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", offset: 0 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", offset: -1 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", offset: 1.5 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", limit: 0 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", startLine: 5, endLine: 4 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", startLine: 0, endLine: 4 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", startLine: 1 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", endLine: 4 }), undefined);
  assert.equal(recognizeReadShapedEdit({ path: "a.ts", startLine: "1", endLine: 4 }), undefined);
});

test("the recognizer is pure: rejected inputs are returned undefined and never mutated", () => {
  const cases: unknown[] = [
    { path: "a.ts", edits: [{ oldText: "a", newText: "b" }], offset: 3 },
    { path: "a.ts", oldText: "a", newText: "b" },
    { path: "a.ts", edits: [] },
    { path: "a.ts", offset: 3, verbose: true },
    { path: "a.ts", offset: 3, startLine: 3, endLine: 9 },
    { path: "a.ts", offset: 0 },
    { path: "a.ts", startLine: 5, endLine: 4 },
    { path: "a.ts", startLine: "1", endLine: 4 },
    { path: "" },
    { offset: 1, limit: 2 },
    {},
    [{ path: "a.ts" }],
    ["a.ts"],
    null,
    "a.ts",
    42,
  ];

  for (const input of cases) {
    const snapshot = structuredClone(input);
    assert.equal(recognizeReadShapedEdit(input), undefined, JSON.stringify(input));
    // The restoration itself must never mutate a rejected call; independent
    // repairs (handled elsewhere) remain free to act on it.
    assert.deepEqual(input, snapshot, `mutated: ${JSON.stringify(input)}`);
  }
});

test("the recognizer is pure: recognized inputs are read-only", () => {
  const input = { path: "a.ts", offset: 3, limit: 2 };
  const snapshot = structuredClone(input);
  assert.deepEqual(recognizeReadShapedEdit(input), { path: "a.ts", offset: 3, limit: 2 });
  assert.deepEqual(input, snapshot);
  assert.notEqual(recognizeReadShapedEdit(input), input, "a fresh read call is returned, never the input");
});

test("renders the exact corrected read call and a truthful, non-success reason", () => {
  assert.equal(renderRestoredReadCall({ path: "src/a b.ts", offset: 3, limit: 2 }), '{"name":"read","arguments":{"path":"src/a b.ts","offset":3,"limit":2}}');
  assert.equal(renderRestoredReadCall({ path: "src/a.ts" }), '{"name":"read","arguments":{"path":"src/a.ts"}}');

  const reason = buildRestoreReadReason({ path: "src/a.ts", offset: 3, limit: 2 });
  assert.match(reason, /blocked this edit/);
  assert.match(reason, /no edit was applied/);
  assert.match(reason, /"name":"read"/);
  assert.doesNotMatch(reason, /succeed|success|applied successfully|try adjusting|please retry/i);
  assert.equal(reason, buildRestoreReadReason({ path: "src/a.ts", offset: 3, limit: 2 }));
});
