import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeHitRates,
  isMissingPathError,
  mineMissingReadPairs,
  pairMetadata,
  type MissingReadPair,
  type ReadTranscript,
} from "./pair-miner.ts";

function call(id: string, path: string, ts = "2026-01-01T00:00:00.000Z") {
  return { toolCallId: id, ts, path };
}
function outcome(id: string, isError: boolean, errorText?: string) {
  return { toolCallId: id, isError, errorText };
}
function transcript(overrides: Partial<ReadTranscript> = {}): ReadTranscript {
  return { sessionId: "session-a", cwd: "/repo", calls: [], outcomes: [], ...overrides };
}

test("isMissingPathError matches ENOENT and no such file only", () => {
  assert.equal(isMissingPathError("ENOENT: no such file or directory"), true);
  assert.equal(isMissingPathError("Error: no such file"), true);
  assert.equal(isMissingPathError("Offset 5 is beyond end of file"), false);
  assert.equal(isMissingPathError(undefined), false);
});

test("pairs a missing read with the next successful read in the same session", () => {
  const pairs = mineMissingReadPairs(transcript({
    calls: [call("f1", "src/confg.ts"), call("f2", "src/config.ts")],
    outcomes: [outcome("f1", true, "ENOENT: no such file or directory"), outcome("f2", false)],
  }));

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.missingPath, "src/confg.ts");
  assert.equal(pairs[0]!.successPath, "src/config.ts");
  assert.equal(pairs[0]!.sessionId, "session-a");
  assert.equal(pairs[0]!.cwd, "/repo");
});

test("ignores non-missing failures, same-path successes, and failures without a later success", () => {
  assert.equal(mineMissingReadPairs(transcript({
    calls: [call("f1", "a.ts"), call("s1", "b.ts")],
    outcomes: [outcome("f1", true, "EISDIR"), outcome("s1", false)],
  })).length, 0);

  assert.equal(mineMissingReadPairs(transcript({
    calls: [call("f1", "a.ts"), call("s1", "a.ts")],
    outcomes: [outcome("f1", true, "ENOENT"), outcome("s1", false)],
  })).length, 0, "same-path success carries no correction signal");

  assert.equal(mineMissingReadPairs(transcript({
    calls: [call("f1", "a.ts")],
    outcomes: [outcome("f1", true, "ENOENT")],
  })).length, 0);

  assert.equal(mineMissingReadPairs(transcript({
    calls: [call("s1", "a.ts"), call("f1", "b.ts")],
    outcomes: [outcome("s1", false), outcome("f1", true, "ENOENT")],
  })).length, 0, "never looks backwards");
});

test("mining is deterministic", () => {
  const build = () => mineMissingReadPairs(transcript({
    calls: [call("f1", "src/confg.ts"), call("f2", "src/config.ts")],
    outcomes: [outcome("f1", true, "ENOENT"), outcome("f2", false)],
  }));
  assert.deepEqual(build(), build());
});

test("pair metadata carries lengths and basename equality, never paths", () => {
  const pair: MissingReadPair = {
    sessionId: "s", cwd: "/repo", failedToolCallId: "f1", failedTs: "t1",
    missingPath: "src/confg.ts", successToolCallId: "f2", successTs: "t2", successPath: "lib/config.ts",
  };
  const metadata = pairMetadata(pair);
  assert.equal(metadata.missingPathLength, 12);
  assert.equal(metadata.successPathLength, 13);
  assert.equal(metadata.sameBasename, false);
  assert.equal(JSON.stringify(metadata).includes("confg"), false);
  assert.equal(JSON.stringify(metadata).includes("config"), false);
});

test("computes deterministic top-1/top-5 hit rates over generated orderings", () => {
  const pairs: MissingReadPair[] = [
    { sessionId: "s", cwd: "/repo", failedToolCallId: "f1", failedTs: "t", missingPath: "a.ts", successToolCallId: "s1", successTs: "t", successPath: "src/a.ts" },
    { sessionId: "s", cwd: "/repo", failedToolCallId: "f2", failedTs: "t", missingPath: "b.ts", successToolCallId: "s2", successTs: "t", successPath: "src/b.ts" },
    { sessionId: "s", cwd: "/repo", failedToolCallId: "f3", failedTs: "t", missingPath: "c.ts", successToolCallId: "s3", successTs: "t", successPath: "src/c.ts" },
  ];
  const rates = computeHitRates(pairs, (pair) => {
    if (pair.failedToolCallId === "f1") return ["src/a.ts", "x.ts"];
    if (pair.failedToolCallId === "f2") return ["y.ts", "src/b.ts"];
    return undefined; // no candidates generated
  });

  assert.deepEqual(rates, { pairs: 3, generated: 2, top1: 1, top5: 2, top1Rate: 0.5, top5Rate: 1 });
});
