/**
 * TASK-0040 — schema-valid built-in calls never reach the classifier.
 *
 * Real Pi built-in schemas drive the matrix: a call the built-in accepts is a
 * normal call (native execution), an exact bash shape still routes
 * deterministically, and only an invalid one-string shape is classified.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

import { createBashRouteState, sentinelTokenOf, wrapToolForBashRouting, preparedArgumentsMatchSchema, type ToolLike } from "./wrapper.ts";

interface Harness {
  prepare(args: unknown): unknown;
  execute(args: unknown): Promise<any>;
  judged: () => number;
  nativeExecutions: () => number;
  bashExecutions: () => number;
  state: ReturnType<typeof createBashRouteState>;
}

const builtins: Record<"read" | "write" | "edit", () => ToolLike> = {
  read: () => createReadToolDefinition("/work") as unknown as ToolLike,
  write: () => createWriteToolDefinition("/work") as unknown as ToolLike,
  edit: () => createEditToolDefinition("/work") as unknown as ToolLike,
};

function harness(toolName: "read" | "write" | "edit", options: { judge?: boolean } = { judge: true }): Harness {
  const state = createBashRouteState({ isEnabled: () => true, isTrusted: () => true });
  const builtin = builtins[toolName]();
  let judged = 0;
  let nativeExecutions = 0;
  let bashExecutions = 0;

  const nativeStub: ToolLike = {
    ...builtin,
    execute: async () => { nativeExecutions++; return { content: [{ type: "text", text: "native" }] }; },
  };

  const wrapper = wrapToolForBashRouting({
    builtin: nativeStub,
    toolName,
    state,
    delegate: async () => { bashExecutions++; return { content: [{ type: "text", text: "bash" }] }; },
    resolveBuiltin: () => nativeStub,
    nextToken: () => "token",
    ...(options.judge === false ? {} : { judgeBash: { judge: async () => { judged++; return { answers: { bash: { choice: "not-bash" } } }; } } }),
  });

  return {
    prepare: wrapper.prepareArguments!,
    execute: (args) => wrapper.execute("c1", args as never, undefined, undefined, context()),
    judged: () => judged,
    nativeExecutions: () => nativeExecutions,
    bashExecutions: () => bashExecutions,
    state,
  };
}

const isSentinel = (args: unknown) => sentinelTokenOf(args) !== undefined;
const context = () => ({ cwd: "/work", isProjectTrusted: () => true });

test("real Pi built-in schemas accept a normal call", () => {
  assert.equal(preparedArgumentsMatchSchema(builtins.read().parameters, { path: "README.md" }), true);
  assert.equal(preparedArgumentsMatchSchema(builtins.read().parameters, { path: "README.md", limit: 5 }), true);
  assert.equal(preparedArgumentsMatchSchema(builtins.write().parameters, { path: "a.txt", content: "x" }), true);
  assert.equal(preparedArgumentsMatchSchema(builtins.edit().parameters, { path: "a.ts", edits: [] }), true);

  assert.equal(preparedArgumentsMatchSchema(builtins.read().parameters, { CMD: "git status" }), false, "missing required path");
  assert.equal(preparedArgumentsMatchSchema(builtins.write().parameters, { path: "a.txt" }), false, "missing required content");
  assert.equal(preparedArgumentsMatchSchema(builtins.read().parameters, { path: 42 }), false, "wrong type");
  assert.equal(preparedArgumentsMatchSchema({}, { CMD: "git status" }), false, "unknown schema never bypasses");
  assert.equal(preparedArgumentsMatchSchema(undefined, { path: "a" }), false);
});

test("schema-valid read/write/edit calls bypass classification and execute natively", async () => {
  const cases: Array<["read" | "write" | "edit", Record<string, unknown>]> = [
    ["read", { path: "README.md" }],
    ["read", { path: "src/index.ts", offset: 10, limit: 5 }],
    ["write", { path: "notes.txt", content: "hello" }],
    ["edit", { path: "src/index.ts", edits: [{ oldText: "a", newText: "b" }] }],
  ];

  for (const [toolName, args] of cases) {
    const h = harness(toolName);
    const prepared = h.prepare(args);

    assert.equal(isSentinel(prepared), false, `${toolName}: no sentinel for a schema-valid call`);
    assert.deepEqual(prepared, args, `${toolName}: arguments pass through unchanged`);

    const result = await h.execute(prepared);
    assert.equal((result.content as any)[0].text, "native", `${toolName}: native execution`);
    assert.equal(h.judged(), 0, `${toolName}: the classifier never ran`);
    assert.equal(h.bashExecutions(), 0, `${toolName}: bash never ran`);
    assert.equal(h.nativeExecutions(), 1, `${toolName}: the built-in executed once`);
  }
});

test("an invalid one-string shape is still classified and never mutates the original", async () => {
  for (const toolName of ["read", "write", "edit"] as const) {
    const h = harness(toolName);
    const args = { CMD: "git status" };
    const prepared = h.prepare(args);

    assert.equal(isSentinel(prepared), true, `${toolName}: an invalid one-string shape is classified`);
    assert.deepEqual(args, { CMD: "git status" }, `${toolName}: the original arguments are untouched`);
  }
});

test("the exact bash shape still routes deterministically before any schema check", async () => {
  const h = harness("read");
  const prepared = h.prepare({ command: "git status", timeout: 30 });

  assert.equal(isSentinel(prepared), true, "the exact shape is routed");
  assert.equal(h.judged(), 0, "and never classified");
});

test("ineligible and unknown-schema shapes stay native", async () => {
  const h = harness("read");
  assert.deepEqual(h.prepare({ path: 42 }), { path: 42 }, "wrong type is not classifiable");

  const stubState = createBashRouteState({ isEnabled: () => true, isTrusted: () => true });
  let judged = 0;
  const stubWrapper = wrapToolForBashRouting({
    builtin: { name: "write", label: "write", description: "stub", parameters: {}, execute: async () => ({ content: [] }) },
    toolName: "write",
    state: stubState,
    delegate: async () => ({ content: [] }),
    resolveBuiltin: () => ({ name: "write", label: "write", description: "stub", parameters: {}, execute: async () => ({ content: [] }) }),
    judgeBash: { judge: async () => { judged++; return { answers: { bash: { choice: "bash" } } }; } },
  });
  assert.equal(isSentinel(stubWrapper.prepareArguments!({ CMD: "git status" })), true, "an unknown schema keeps the TASK-0038 path");
  assert.equal(judged, 0, "the classifier runs at execute, not at prepare");
});
