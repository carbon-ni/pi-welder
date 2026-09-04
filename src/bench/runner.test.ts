import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_MESSAGE, SHIPPED, type BenchCandidate } from "./baselines.ts";
import { runReplay, runReplayWithModel, type ModelClient } from "./runner.ts";
import type { BenchEpisode } from "./dataset.ts";

function episodes(n: number, overrides: Partial<BenchEpisode> = {}): BenchEpisode[] {
  return Array.from({ length: n }, (_, i) => ({
    episodeId: `ep-${i}`,
    kind: "repair-warning" as const,
    sessionId: "s1",
    toolName: "edit",
    repairs: ["nest-edit-fields"],
    inputKeys: ["edits"],
    outcome: (i % 2 === 0 ? "valid" : "repaired-recurrence") as BenchEpisode["outcome"],
    ...overrides,
  }));
}

function jsonClient(response: () => { content: string; tokens?: number; latencyMs?: number }): ModelClient {
  return {
    async complete() {
      const res = response();
      return { content: res.content, tokens: res.tokens ?? 10, latencyMs: res.latencyMs ?? 5 };
    },
  };
}

const CAPS = { timeoutMs: 1000, retryCap: 1, concurrencyCap: 2, costBudgetUsd: 1, usdPerToken: 0.001 };

test("baselines reproduce recorded outcomes deterministically without a model client", () => {
  const dataset = episodes(4);
  const b0 = runReplay(dataset, NO_MESSAGE);
  const b1 = runReplay(dataset, SHIPPED);
  const { candidateId: _c0, ...rest0 } = b0;
  const { candidateId: _c1, ...rest1 } = b1;

  assert.equal(b0.candidateId, "B0-no-message");
  assert.equal(b0.score, 0.5);
  assert.equal(b0.byOutcome.valid, 2);
  assert.equal(b0.byOutcome["repaired-recurrence"], 2);
  assert.equal(b0.repairs, 2);
  assert.deepEqual(rest0, rest1);
});

test("runner refuses to score sealed (redacted) holdout episodes", () => {
  const redacted = episodes(1).map(({ outcome: _outcome, ...rest }) => rest) as unknown as BenchEpisode[];
  assert.throws(() => runReplay(redacted, NO_MESSAGE), /sealed holdout/);
});

test("model client runs require bounded caps", async () => {
  await assert.rejects(
    runReplayWithModel(episodes(1), NO_MESSAGE, {
      modelClient: jsonClient(() => ({ content: "{}" })),
      caps: { timeoutMs: 0, retryCap: 2, concurrencyCap: 2, costBudgetUsd: 1 },
    }),
    /timeoutMs/,
  );
  await assert.rejects(
    runReplayWithModel(episodes(1), NO_MESSAGE, {
      modelClient: jsonClient(() => ({ content: "{}" })),
      caps: { timeoutMs: 1000, retryCap: -1, concurrencyCap: 2, costBudgetUsd: 1 },
    }),
    /retryCap/,
  );
});

test("mock model happy path scores valid retries and records cost metrics", async () => {
  const client = jsonClient(() => ({ content: JSON.stringify({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }), tokens: 20, latencyMs: 7 }));
  const result = await runReplayWithModel(episodes(2), SHIPPED, { modelClient: client, caps: CAPS });

  assert.equal(result.score, 1);
  assert.equal(result.byOutcome.valid, 2);
  assert.equal(result.calls, 2);
  assert.equal(result.tokens, 40);
  assert.equal(result.latencyMs, 14);
  assert.equal(result.costUsd, 0.04);
  assert.equal(result.errorClass, "none");
  assert.equal(result.outputMode, "text-json");
});

test("mock model unhappy path labels schema-invalid retries as failed (P2 FRV)", async () => {
  const client = jsonClient(() => ({ content: "not json at all" }));
  const result = await runReplayWithModel(
    episodes(1, { kind: "result-repair", repairs: ["missing-read-context"], outcome: "valid" }),
    SHIPPED,
    { modelClient: client, caps: { ...CAPS, concurrencyCap: 1 } },
  );

  assert.equal(result.population, "P2");
  assert.equal(result.score, 0);
  assert.equal(result.byOutcome.failed, 1);
  assert.ok(result.failures.some((f) => f.reason.includes("unparseable")));
});

test("repaired model retries are labeled repaired-recurrence or repaired-other", async () => {
  const recurrence = jsonClient(() => ({ content: JSON.stringify({ edits: { oldText: "a", newText: "b" } }) }));
  const other = jsonClient(() => ({ content: JSON.stringify({ path: null, edits: [{ oldText: "a", newText: "b" }] }) }));
  const caps = { ...CAPS, concurrencyCap: 1 };

  const r1 = await runReplayWithModel(episodes(1, { repairs: ["wrap-object-array"] }), SHIPPED, { modelClient: recurrence, caps });
  const r2 = await runReplayWithModel(episodes(1), SHIPPED, { modelClient: other, caps });

  assert.equal(r1.byOutcome["repaired-recurrence"], 1);
  assert.equal(r2.byOutcome["repaired-other"], 1);
});

test("client failures retry up to the cap then succeed", async () => {
  let attempts = 0;
  const flaky: ModelClient = {
    async complete() {
      attempts++;
      if (attempts < 3) throw new Error("boom");
      return { content: JSON.stringify({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }), tokens: 5, latencyMs: 1 };
    },
  };
  const result = await runReplayWithModel(episodes(1), SHIPPED, {
    modelClient: flaky,
    caps: { ...CAPS, retryCap: 2, concurrencyCap: 1 },
  });

  assert.equal(attempts, 3);
  assert.equal(result.retries, 2);
  assert.equal(result.errorClass, "none");
  assert.equal(result.score, 1);
});

test("client failures beyond the retry cap fail the episode", async () => {
  const dead: ModelClient = { async complete() { throw new Error("down"); } };
  const result = await runReplayWithModel(
    episodes(1, { kind: "result-repair", repairs: ["missing-read-context"], outcome: "valid" }),
    SHIPPED,
    { modelClient: dead, caps: { ...CAPS, concurrencyCap: 1 } },
  );

  assert.equal(result.errorClass, "client-error");
  assert.equal(result.byOutcome.failed, 1);
  assert.equal(result.score, 0);
});

test("cost budget aborts remaining episodes deterministically", async () => {
  const expensive = jsonClient(() => ({ content: "{}", tokens: 1_000_000 }));
  const result = await runReplayWithModel(episodes(3), SHIPPED, {
    modelClient: expensive,
    caps: { timeoutMs: 1000, retryCap: 1, concurrencyCap: 1, costBudgetUsd: 0.5, usdPerToken: 0.001 },
  });

  assert.equal(result.errorClass, "budget-exceeded");
  assert.ok(result.calls < 3);
  assert.equal(result.failures.filter((f) => f.reason === "budget-exceeded").length, 3);
});

test("candidate messages for repair-free episodes are structurally disqualified", async () => {
  const chatty: BenchCandidate = { id: "chatty", message: () => "nest-edit-fields advice" };
  const result = await runReplayWithModel(episodes(1, { repairs: [] }), chatty, {
    modelClient: jsonClient(() => ({ content: "{}" })),
    caps: CAPS,
  });

  assert.equal(result.disqualifications.length, 1);
  assert.match(result.disqualifications[0] ?? "", /chatty/);
});

test("mixed populations are rejected; population matches episode kind", async () => {
  assert.throws(() => runReplay([
    ...episodes(1),
    { ...episodes(1)[0]!, episodeId: "ep-x", kind: "result-repair" as const },
  ], NO_MESSAGE), /mixed-population/);

  const p2 = await runReplayWithModel(
    episodes(1, { kind: "result-repair", repairs: ["missing-read-context"], outcome: "valid" }),
    SHIPPED,
    { modelClient: jsonClient(() => ({ content: "{}" })), caps: CAPS },
  );
  assert.equal(p2.population, "P2");
});
