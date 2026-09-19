import { test } from "node:test";
import assert from "node:assert/strict";

import { mineAmbiguousPairs, reportedOccurrences, type SessionTranscript } from "./replay-pairs.ts";

function call(id: string, path: string, oldText: string, newText: string, ts = "2026-01-01T00:00:00.000Z") {
  return { toolCallId: id, ts, path, oldText, newText };
}

function transcript(overrides: Partial<SessionTranscript> = {}): SessionTranscript {
  return {
    sessionId: "session-a",
    cwd: "/repo",
    calls: [],
    outcomes: [],
    ...overrides,
  };
}

function outcome(id: string, isError: boolean, errorText?: string) {
  return { toolCallId: id, isError, errorText };
}

test("reportedOccurrences parses 2-5 exact counts from the ambiguity error text", () => {
  assert.equal(reportedOccurrences("Found 2 occurrences of the text in bin/tmux-sp. The text must be unique."), 2);
  assert.equal(reportedOccurrences("Found 5 occurrences of edits[1] in a.ts. Each oldText must be unique."), 5);
  assert.equal(reportedOccurrences("Found 1 occurrences of the text in a.ts."), 1);
  assert.equal(reportedOccurrences("Found 12 occurrences of the text in a.ts."), 12);
  assert.equal(reportedOccurrences("some unrelated failure"), undefined);
  assert.equal(reportedOccurrences(undefined), undefined);
});

test("mines a pair when a 2-5-occurrence failure is later fixed by a strictly extending success", () => {
  const pairs = mineAmbiguousPairs(transcript({
    calls: [
      call("call-fail", "src/a.ts", "return value;", "return next;"),
      call("call-fix", "src/a.ts", "function a() {\n  return value;\n}", "function a() {\n  return next;\n}"),
    ],
    outcomes: [
      outcome("call-fail", true, "Found 2 occurrences of the text in src/a.ts. The text must be unique."),
      outcome("call-fix", false),
    ],
  }));

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.sessionId, "session-a");
  assert.equal(pairs[0]!.cwd, "/repo");
  assert.equal(pairs[0]!.failedToolCallId, "call-fail");
  assert.equal(pairs[0]!.successfulToolCallId, "call-fix");
  assert.equal(pairs[0]!.failedOccurrences, 2);
  assert.equal(pairs[0]!.failedOldTextLength, "return value;".length);
  assert.equal(pairs[0]!.successfulOldTextLength, "function a() {\n  return value;\n}".length);
});

test("ignores failures reporting fewer than two or more than five occurrences", () => {
  const calls = [call("call-fail", "src/a.ts", "a", "b"), call("call-fix", "src/a.ts", "a long", "b long")];
  for (const count of [1, 6, 12]) {
    const pairs = mineAmbiguousPairs(transcript({
      calls,
      outcomes: [outcome("call-fail", true, `Found ${count} occurrences of the text in src/a.ts.`), outcome("call-fix", false)],
    }));
    assert.equal(pairs.length, 0, `occurrence count ${count} must not pair`);
  }
});

test("ignores failures without an ambiguity error, and successes that errored or lack results", () => {
  const calls = [call("call-fail", "src/a.ts", "a", "b"), call("call-fix", "src/a.ts", "a long", "b long")];
  const ambiguousError = "Found 2 occurrences of the text in src/a.ts.";

  assert.equal(mineAmbiguousPairs(transcript({
    calls,
    outcomes: [outcome("call-fail", true, "File not found"), outcome("call-fix", false)],
  })).length, 0);
  assert.equal(mineAmbiguousPairs(transcript({
    calls,
    outcomes: [outcome("call-fail", true, ambiguousError), outcome("call-fix", true, ambiguousError)],
  })).length, 0);
  assert.equal(mineAmbiguousPairs(transcript({
    calls,
    outcomes: [outcome("call-fail", true, ambiguousError)],
  })).length, 0);
});

test("requires the same path and a strictly extending oldText", () => {
  const ambiguousError = "Found 2 occurrences of the text in src/a.ts.";
  const fail = call("call-fail", "src/a.ts", "return value;", "return next;");
  const outcomes = [outcome("call-fail", true, ambiguousError), outcome("call-fix", false)];

  assert.equal(mineAmbiguousPairs(transcript({
    calls: [fail, call("call-fix", "src/other.ts", "x return value;", "y")],
    outcomes,
  })).length, 0, "different path must not pair");

  assert.equal(mineAmbiguousPairs(transcript({
    calls: [fail, call("call-fix", "src/a.ts", "return value;", "return next;")],
    outcomes,
  })).length, 0, "identical oldText is not an extension");

  assert.equal(mineAmbiguousPairs(transcript({
    calls: [fail, call("call-fix", "src/a.ts", "return val", "return next;")],
    outcomes,
  })).length, 0, "shorter oldText does not contain the failed one");
});

test("pairs each failure with the first qualifying success and never looks backwards", () => {
  const ambiguousError = "Found 2 occurrences of the text in src/a.ts.";
  const pairs = mineAmbiguousPairs(transcript({
    calls: [
      call("call-early", "src/a.ts", "aa return value;", "aa next"),
      call("call-fail", "src/a.ts", "return value;", "return next;"),
      call("call-first", "src/a.ts", "x {\n  return value;\n}", "x next"),
      call("call-second", "src/a.ts", "y {\n  return value;\n}", "y next"),
    ],
    outcomes: [
      outcome("call-early", false),
      outcome("call-fail", true, ambiguousError),
      outcome("call-first", false),
      outcome("call-second", false),
    ],
  }));

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.successfulToolCallId, "call-first");
});

test("two failures can share one eventual success, forming two pairs", () => {
  const ambiguousError = "Found 2 occurrences of the text in src/a.ts.";
  const pairs = mineAmbiguousPairs(transcript({
    calls: [
      call("call-fail-1", "src/a.ts", "alpha", "alpha!"),
      call("call-fail-2", "src/a.ts", "beta", "beta!"),
      call("call-fix", "src/a.ts", "prefix alpha suffix\nbeta", "fixed"),
    ],
    outcomes: [
      outcome("call-fail-1", true, ambiguousError),
      outcome("call-fail-2", true, "Found 3 occurrences of the text in src/a.ts."),
      outcome("call-fix", false),
    ],
  }));

  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((pair) => pair.failedToolCallId), ["call-fail-1", "call-fail-2"]);
  assert.ok(pairs.every((pair) => pair.successfulToolCallId === "call-fix"));
});

test("mining is deterministic: the same transcript yields identical pairs", () => {
  const build = () => mineAmbiguousPairs(transcript({
    calls: [
      call("call-fail", "src/a.ts", "return value;", "return next;", "2026-01-01T00:00:01.000Z"),
      call("call-fix", "src/a.ts", "fn {\n  return value;\n}", "fn next", "2026-01-01T00:00:02.000Z"),
    ],
    outcomes: [outcome("call-fail", true, "Found 3 occurrences of the text in src/a.ts."), outcome("call-fix", false)],
  }));

  assert.deepEqual(build(), build());
  assert.deepEqual(JSON.stringify(build()), JSON.stringify(build()));
});
