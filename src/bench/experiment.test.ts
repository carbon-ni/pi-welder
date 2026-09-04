import { test } from "node:test";
import assert from "node:assert/strict";

import {
  auditHoldout,
  runTransparencyExperiment,
  MIN_HOLDOUT_PER_CLUSTER,
  type EpisodeFileInput,
} from "./experiment.ts";
import type { BenchEpisode } from "./dataset.ts";

function episodesFor(sessionId: string, actions: string[], count: number, outcome: BenchEpisode["outcome"] = "valid"): BenchEpisode[] {
  return Array.from({ length: count }, (_, i) => ({
    episodeId: `${sessionId}-ep-${i}`,
    kind: "repair-warning" as const,
    sessionId,
    toolName: "edit",
    repairs: actions,
    inputKeys: ["edits"],
    outcome,
  }));
}

function sources(episodes: readonly BenchEpisode[]): EpisodeFileInput[] {
  const bySession = new Map<string, BenchEpisode[]>();
  for (const episode of episodes) {
    const list = bySession.get(episode.sessionId) ?? [];
    list.push(episode);
    bySession.set(episode.sessionId, list);
  }
  return Array.from(bySession, ([sessionId, list]) => ({
    sessionId,
    // sessionId is carried by the source; events are loader-shaped records.
    events: list.map(({ sessionId: _s, ...rest }) => ({ eventType: "episode", ...rest })) as unknown as Record<string, unknown>[],
  }));
}

test("threshold constant matches contract (30 holdout episodes per action cluster)", () => {
  assert.equal(MIN_HOLDOUT_PER_CLUSTER, 30);
});

test("no-go when recorded episodes are insufficient per action cluster", () => {
  const eps = [...episodesFor("s1", ["nest-edit-fields"], 3), ...episodesFor("s2", ["wrap-array"], 2)];
  const decision = auditHoldout(sources(eps));
  assert.equal(decision.decision, "no-go");
  assert.match(decision.reason ?? "", /insufficient-data/);
  const byAction = new Map(decision.perAction.map((c) => [c.action, c.holdoutCount]));
  assert.ok((byAction.get("nest-edit-fields") ?? 0) < MIN_HOLDOUT_PER_CLUSTER);
  assert.equal(decision.threshold, MIN_HOLDOUT_PER_CLUSTER);
});

test("proceed only when every action cluster reaches the holdout threshold", () => {
  const eps: BenchEpisode[] = [];
  for (let s = 0; s < 15; s++) {
    eps.push(...episodesFor(`s${s}`, ["nest-edit-fields", "wrap-array"], 10, s % 2 ? "valid" : "repaired-recurrence"));
  }
  const decision = auditHoldout(sources(eps));
  assert.equal(decision.decision, "proceed");
  assert.ok(decision.perAction.every((c) => c.sufficient));
});

test("experiment on insufficient data is an explicit no-go with no holdout results and no winner", () => {
  const eps = [...episodesFor("s1", ["nest-edit-fields"], 3)];
  const result = runTransparencyExperiment(sources(eps));
  assert.equal(result.decision, "no-go");
  assert.equal(result.winner, null);
  assert.equal(result.holdout, undefined);
});

test("candidate search runs on train/dev only; holdout used once for final scoring", () => {
  const eps: BenchEpisode[] = [];
  for (let s = 0; s < 15; s++) {
    eps.push(...episodesFor(`s${s}`, ["nest-edit-fields"], 10, s % 2 ? "valid" : "repaired-recurrence"));
  }
  const result = runTransparencyExperiment(sources(eps), { seed: 42 });
  assert.equal(result.decision, "proceed");
  assert.ok(result.search);
  assert.equal(result.search?.seed, 42);
  assert.ok(result.holdout);
  const winnerId = result.winner ?? "";
  const cluster = result.holdout["nest-edit-fields"]?.[winnerId];
  assert.ok(cluster, "winner cluster metrics missing");
  assert.ok(cluster.nrr >= 0 && cluster.nrr <= 1);
  assert.ok(cluster.recurrencePerCall >= 0);
  assert.ok(cluster.messageTokens >= 0);
  // Safety gates are reported for messaging candidates (B1); the winner may
  // legitimately be no-message, whose gate set is no-message + zero-content.
  const b1 = result.holdout["nest-edit-fields"]?.["B1-shipped"];
  assert.ok(b1, "B1 metrics missing");
  assert.ok(b1.safetyGates.includes("no-generic-recovery"));
  assert.ok(b1.safetyGates.includes("references-repair-action"));
});

test("no-message is the valid winner on ties (minimum message cost)", () => {
  const eps: BenchEpisode[] = [];
  for (let s = 0; s < 15; s++) {
    eps.push(...episodesFor(`s${s}`, ["nest-edit-fields"], 10, "valid"));
  }
  const result = runTransparencyExperiment(sources(eps), { seed: 42 });
  // All-valid outcomes: every message variant ties with no-message on NRR;
  // the deterministic tie-break must pick the zero-cost no-message baseline.
  assert.equal(result.winner, "B0-no-message");
});

test("per-action results attribute recurrence to the right repair action", () => {
  const eps: BenchEpisode[] = [];
  for (let s = 0; s < 15; s++) {
    eps.push(...episodesFor(`s${s}`, ["nest-edit-fields"], 20, "repaired-recurrence"));
    eps.push(...episodesFor(`s${s}`, ["wrap-array"], 20, "valid"));
  }
  const result = runTransparencyExperiment(sources(eps), { seed: 1 });
  const winnerId = result.winner ?? "";
  const nest = result.holdout?.["nest-edit-fields"]?.[winnerId];
  const wrap = result.holdout?.["wrap-array"]?.[winnerId];
  assert.ok(nest, "nest cluster missing");
  assert.ok(wrap, "wrap cluster missing");
  assert.equal(nest.recurrencePerCall, 1);
  assert.equal(wrap.recurrencePerCall, 0);
  assert.ok(nest.nrr < wrap.nrr);
});
