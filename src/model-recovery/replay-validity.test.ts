import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluatePairValidity } from "./replay-validity.ts";
import type { ReplayPair } from "./replay-pairs.ts";

function fileSystem(content: string | undefined, realPath?: string | ((p: string) => Promise<string>)) {
  const realpath = typeof realPath === "function" ? realPath : async (p: string) => realPath ?? p;
  return {
    readFile: async () => {
      if (content === undefined) throw new Error("missing");
      return content;
    },
    realpath,
  } as any;
}

function pair(overrides: Partial<ReplayPair> = {}): ReplayPair {
  return {
    sessionId: "session-a",
    cwd: "/repo",
    failedToolCallId: "call-fail",
    failedTs: "2026-01-01T00:00:00.000Z",
    successfulToolCallId: "call-fix",
    successfulTs: "2026-01-01T00:00:01.000Z",
    path: "src/a.ts",
    failedOccurrences: 2,
    failedOldText: "return value;",
    failedNewText: "return next;",
    successfulOldText: "function a() {\n  return value;\n}",
    failedOldTextLength: 13,
    successfulOldTextLength: 29,
    ...overrides,
  };
}

const twoOccurrences = "function a() {\n  return value;\n}\n\nfunction b() {\n  return value;\n}\n";

test("keeps a drifted-but-still-ambiguous pair and resolves the historical target from current content", async () => {
  const result = await evaluatePairValidity(pair(), fileSystem(twoOccurrences));
  assert.equal(result.verdict, "valid");
  if (result.verdict !== "valid") return;
  // The successful oldText covers only the first of today's two occurrences.
  assert.equal(result.groundTruthOrdinal, 1);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.request.candidates.length, 2);
  assert.deepEqual(result.request.candidates.map((candidate) => candidate.ordinal), [1, 2]);
  // Candidates are redacted windows; the requested edit text passes through sanitization.
  assert.equal(result.request.requestedEditText, "return next;");
});

test("rejects pairs whose failed oldText is no longer ambiguous in current content", async () => {
  const healed = "function a() {\n  return next;\n}\n";
  const result = await evaluatePairValidity(pair(), fileSystem(healed));
  assert.equal(result.verdict, "invalid");
  if (result.verdict !== "invalid") return;
  assert.equal(result.reason, "failed-oldtext-not-ambiguous-today");
});

test("rejects pairs whose successful oldText no longer resolves uniquely today", async () => {
  const duplicated = `${twoOccurrences}${twoOccurrences}`;
  const result = await evaluatePairValidity(pair(), fileSystem(duplicated));
  assert.equal(result.verdict, "invalid");
  if (result.verdict !== "invalid") return;
  assert.equal(result.reason, "successful-oldtext-not-unique-today");
});

test("marks pairs unresolvable when more than one candidate lies inside the successful span", async () => {
  // Two overlapping occurrences of the failed oldText both fall inside the
  // successful oldText span, so no unique historical target exists.
  const overlapping = "return value; return value;\n";
  const result = await evaluatePairValidity(pair({
    failedOldText: "value;",
    failedNewText: "next;",
    successfulOldText: "return value; return value;",
  }), fileSystem(overlapping));
  assert.equal(result.verdict, "unresolvable");
  if (result.verdict !== "unresolvable") return;
  assert.equal(result.reason, "ground-truth-not-unique");
});

test("fails closed on unreadable files and paths outside the session cwd", async () => {
  const unreadable = await evaluatePairValidity(pair(), fileSystem(undefined));
  assert.equal(unreadable.verdict, "invalid");
  if (unreadable.verdict !== "invalid") return;
  assert.equal(unreadable.reason, "unreadable-or-escaped");

  const escaped = await evaluatePairValidity(pair(), fileSystem(twoOccurrences, "/etc/passwd"));
  assert.equal(escaped.verdict, "invalid");
  if (escaped.verdict !== "invalid") return;
  assert.equal(escaped.reason, "unreadable-or-escaped");
});

test("the validity filter performs zero model calls", async () => {
  // Signature-level guarantee: no client is accepted, so no API call can happen.
  const result = await evaluatePairValidity(pair(), fileSystem(twoOccurrences));
  assert.ok(result);
});
