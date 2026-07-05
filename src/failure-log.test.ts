import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  emptyLog,
  recordFailure,
  summarize,
  type ToolResultInput,
} from "./failure-log.ts";

// ---- classifyFailure: the load-bearing filter -------------------------------

test("classifyFailure: non-error result is not a failure", () => {
  const input: ToolResultInput = {
    toolName: "bash",
    isError: false,
    details: { exitCode: 0 },
    content: [{ type: "text", text: "ok" }],
  };
  assert.equal(classifyFailure(input), null);
});

test("classifyFailure: bash with defined exitCode is a CLI result, excluded even if isError", () => {
  const input: ToolResultInput = {
    toolName: "bash",
    isError: true,
    details: { exitCode: 1 },
    content: [{ type: "text", text: "command not found" }],
  };
  assert.equal(classifyFailure(input), null);
});

test("classifyFailure: bash spawn failure (no exitCode) is a harness failure", () => {
  const input: ToolResultInput = {
    toolName: "bash",
    isError: true,
    details: { exitCode: undefined },
    content: [{ type: "text", text: "spawn failed" }],
  };
  assert.deepEqual(classifyFailure(input), { kind: "harness" });
});

test("classifyFailure: schema/validation text is classified as syntax", () => {
  const input: ToolResultInput = {
    toolName: "read",
    isError: true,
    content: [{ type: "text", text: "Parameter validation failed: path is required" }],
  };
  assert.deepEqual(classifyFailure(input), { kind: "syntax" });
});

test("classifyFailure: malformed JSON tool args -> syntax", () => {
  const input: ToolResultInput = {
    toolName: "edit",
    isError: true,
    content: [{ type: "text", text: "Unexpected token in JSON at position 0" }],
  };
  assert.deepEqual(classifyFailure(input), { kind: "syntax" });
});

test("classifyFailure: read missing file -> harness", () => {
  const input: ToolResultInput = {
    toolName: "read",
    isError: true,
    content: [{ type: "text", text: "ENOENT: no such file" }],
  };
  assert.deepEqual(classifyFailure(input), { kind: "harness" });
});

test("classifyFailure: unknown tool name -> harness", () => {
  const input: ToolResultInput = {
    toolName: "banana",
    isError: true,
    content: [{ type: "text", text: "Unknown tool" }],
  };
  assert.deepEqual(classifyFailure(input), { kind: "harness" });
});

// ---- recordFailure: immutable append ---------------------------------------

test("recordFailure: appends with id=1 on empty log", () => {
  const fixedTime = () => "2026-07-05T10:00:00.000Z";
  const log = emptyLog();
  const next = recordFailure(
    log,
    { kind: "syntax", toolName: "read", toolCallId: "c1", cwd: "/x", input: {}, errorContent: "boom" },
    fixedTime,
  );
  assert.deepEqual(next, {
    nextId: 2,
    failures: [
      {
        id: 1,
        timestamp: "2026-07-05T10:00:00.000Z",
        kind: "syntax",
        toolName: "read",
        toolCallId: "c1",
        cwd: "/x",
        input: {},
        errorContent: "boom",
      },
    ],
  });
});

test("recordFailure: does not mutate the original log", () => {
  const fixedTime = () => "2026-07-05T10:00:00.000Z";
  const log = emptyLog();
  recordFailure(
    log,
    { kind: "harness", toolName: "bash", toolCallId: "c1", cwd: "/x", input: {}, errorContent: "x" },
    fixedTime,
  );
  assert.equal(log.failures.length, 0);
  assert.equal(log.nextId, 1);
});

test("recordFailure: increments id across multiple records", () => {
  const fixedTime = () => "2026-07-05T10:00:00.000Z";
  let log = emptyLog();
  log = recordFailure(log, { kind: "syntax", toolName: "a", toolCallId: "c1", cwd: "/", input: {}, errorContent: "e1" }, fixedTime);
  log = recordFailure(log, { kind: "harness", toolName: "b", toolCallId: "c2", cwd: "/", input: {}, errorContent: "e2" }, fixedTime);
  assert.equal(log.failures[0].id, 1);
  assert.equal(log.failures[1].id, 2);
  assert.equal(log.nextId, 3);
});

// ---- summarize --------------------------------------------------------------

test("summarize: empty log", () => {
  assert.equal(summarize(emptyLog()), "No failures recorded.");
});

test("summarize: lists failures with id, kind, tool, snippet", () => {
  const fixedTime = () => "2026-07-05T10:00:00.000Z";
  let log = emptyLog();
  log = recordFailure(log, { kind: "syntax", toolName: "read", toolCallId: "c1", cwd: "/", input: {}, errorContent: "path is required" }, fixedTime);
  log = recordFailure(log, { kind: "harness", toolName: "bash", toolCallId: "c2", cwd: "/", input: {}, errorContent: "spawn failed badly" }, fixedTime);
  const out = summarize(log);
  assert.match(out, /2 failures/);
  assert.match(out, /#1.*syntax.*read.*path is required/);
  assert.match(out, /#2.*harness.*bash.*spawn failed badly/);
});
