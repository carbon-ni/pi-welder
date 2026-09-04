import { test } from "node:test";
import assert from "node:assert/strict";

import { loadEpisodes, splitEpisodes, type BenchEpisode } from "./dataset.ts";

function episodeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "t",
    eventType: "episode",
    episodeId: "ep-1",
    kind: "repair-warning",
    toolName: "edit",
    provider: "p",
    model: "m",
    repairs: ["nest-edit-fields"],
    wasRepaired: false,
    inputKeys: ["edits"],
    outcome: "valid",
    window: 3,
    unrelatedCalls: 0,
    ...overrides,
  };
}

function session(sessionId: string, events: Record<string, unknown>[]) {
  return { sessionId, events: events as any[] };
}

test("loads valid episode events and skips non-episode events", () => {
  const result = loadEpisodes([
    session("s1", [episodeEvent(), { eventType: "tool_call", toolName: "edit" }]),
  ]);

  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.sessionId, "s1");
  assert.equal(result.rejected.length, 0);
});

test("rejects incomplete episodes missing identity or outcome", () => {
  const result = loadEpisodes([
    session("s1", [
      episodeEvent({ episodeId: undefined }),
      episodeEvent({ episodeId: "ep-2", toolName: "" }),
      episodeEvent({ episodeId: "ep-3", outcome: undefined }),
      episodeEvent({ episodeId: "ep-4", repairs: [] }),
    ]),
  ]);

  assert.equal(result.episodes.length, 0);
  assert.equal(result.rejected.length, 4);
});

test("rejects content-bearing episodes", () => {
  const result = loadEpisodes([
    session("s1", [
      episodeEvent({ errorText: "ENOENT: no such file" }),
      episodeEvent({ episodeId: "ep-2", content: "secret content" }),
      episodeEvent({ episodeId: "ep-3", command: "rm -rf /" }),
      episodeEvent({ episodeId: "ep-4", oldText: "source text" }),
    ]),
  ]);

  assert.equal(result.episodes.length, 0);
  assert.equal(result.rejected.length, 4);
  assert.ok(result.rejected.every((issue) => issue.reason.includes("content-bearing")));
});

test("rejects unknown repair actions and unexpected fields", () => {
  const result = loadEpisodes([
    session("s1", [
      episodeEvent({ episodeId: "ep-2", repairs: ["make-it-better"] }),
      episodeEvent({ episodeId: "ep-3", userPrompt: "please fix" }),
    ]),
  ]);

  assert.equal(result.episodes.length, 0);
  assert.equal(result.rejected.length, 2);
});

test("split is deterministic, session-atomic, and seals holdout labels", () => {
  const episodes: BenchEpisode[] = [];
  for (let i = 0; i < 10; i++) {
    episodes.push({
      episodeId: `ep-${i}`,
      kind: "repair-warning",
      sessionId: `session-${i}`,
      toolName: "edit",
      repairs: ["nest-edit-fields"],
      inputKeys: ["edits"],
      outcome: i % 2 === 0 ? "valid" : "failed",
    });
  }

  const first = splitEpisodes(episodes);
  const second = splitEpisodes(episodes);
  assert.deepEqual(first.train.map((e) => e.episodeId), second.train.map((e) => e.episodeId));

  const sessionIds = new Set(first.holdout.redacted.map((e) => e.sessionId));
  for (const episode of [...first.train, ...first.dev]) {
    assert.ok(!sessionIds.has(episode.sessionId), "session leaked across splits");
  }

  for (const redacted of first.holdout.redacted) {
    assert.equal((redacted as unknown as BenchEpisode).outcome, undefined);
  }
  assert.equal(first.holdout.unseal().length, first.holdout.redacted.length);
  assert.ok(first.holdout.unseal()[0]?.outcome);
});

test("holdout unseal is one-way and repeat reads need explicit unseal each time", () => {
  const result = loadEpisodes([session("s1", [episodeEvent()])]);
  const split = splitEpisodes(result.episodes);
  split.holdout.seal();
  assert.throws(() => split.holdout.unseal(), /sealed/);
});
