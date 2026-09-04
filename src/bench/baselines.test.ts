import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_MESSAGE, SHIPPED, validateCandidateMessage, type BenchCandidate } from "./baselines.ts";
import type { BenchEpisode } from "./dataset.ts";

function episode(overrides: Partial<BenchEpisode> = {}): BenchEpisode {
  return {
    episodeId: "ep-1",
    kind: "repair-warning",
    sessionId: "s1",
    toolName: "edit",
    repairs: ["nest-edit-fields"],
    inputKeys: ["edits"],
    outcome: "valid",
    ...overrides,
  };
}

test("B0 baseline never emits a message", () => {
  assert.equal(NO_MESSAGE.message(episode()), null);
});

test("B1 reproduces shipped repair-warning hint text", () => {
  const message = SHIPPED.message(episode());
  assert.ok(message);
  assert.match(message, /pi-welder repair hints/);
  assert.match(message, /nest-edit-fields/);
  assert.match(message, /oldText, newText/);
});

test("B1 emits factual result-enrichment summaries for result repairs", () => {
  const message = SHIPPED.message(episode({ kind: "result-repair", repairs: ["missing-read-context"] }));
  assert.ok(message);
  assert.match(message, /missing-read-context/);
  assert.match(message, /directory listing/);
});

test("B1 returns null when a result repair has no shipped fact", () => {
  assert.equal(SHIPPED.message(episode({ kind: "result-repair", repairs: ["unknown-action"] })), null);
});

test("candidate messages must reference an episode action", () => {
  assert.match(
    validateCandidateMessage(episode(), "unrelated prose without any action") ?? "null",
    /missing-action-reference/,
  );
  assert.equal(validateCandidateMessage(episode(), "retry failed: nest-edit-fields fired"), null);
});

test("generic recovery phrasing is structurally rejected", () => {
  assert.match(
    validateCandidateMessage(episode(), "let's try reading the file again nest-edit-fields") ?? "null",
    /generic-recovery/,
  );
  assert.match(
    validateCandidateMessage(episode(), "we apologize, nest-edit-fields happened") ?? "null",
    /generic-recovery/,
  );
});

test("messages above 480 characters are rejected", () => {
  const message = `nest-edit-fields ${"x".repeat(500)}`;
  assert.match(validateCandidateMessage(episode(), message) ?? "null", /too-long/);
});

test("null messages are always valid", () => {
  assert.equal(validateCandidateMessage(episode(), null), null);
});

test("candidates are named for comparison", () => {
  const custom: BenchCandidate = { id: "cand-1", message: () => null };
  assert.equal(custom.id, "cand-1");
  assert.equal(SHIPPED.id, "B1-shipped");
  assert.equal(NO_MESSAGE.id, "B0-no-message");
});
