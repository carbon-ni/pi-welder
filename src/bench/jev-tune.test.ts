import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BASELINE_VARIANT,
  TUNE_VARIANTS,
  decideRecommendation,
  renderTuneJson,
  renderTuneMarkdown,
  runTuneVariant,
  type TuneReport,
  type VariantResult,
} from "./jev-tune.ts";
import { JEV_PROBE_FIXTURES, PROBE_TIERS, jevProbeRequest, createJevProbeSelector } from "./probe-fixtures.ts";
import { createTypeSafeJevClient, DEFAULT_JEV_PROMPT, type JevClient, type JevSelectionRequest, type JevSelectionResponse } from "../infra/typesafe.ts";

/** Deterministic client: consumes a scripted answer per call, in order. */
function scriptedClient(script: JevSelectionResponse[]): JevClient {
  let index = 0;
  return {
    async choose(_request, _signal) {
      return script[Math.min(index++, script.length - 1)]!;
    },
  };
}

test("the default prompt spec is byte-for-byte the live shadow prompt", async () => {
  const captured: { body: any } = { body: undefined };
  const client = createTypeSafeJevClient({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: "m", answers: { selection: { type: "choice", choice: "abstain" } } }), { status: 200 });
    },
  });
  await client.choose({ candidates: [{ ordinal: 1, window: "w" }], requestedEditText: "x" }, new AbortController().signal);
  assert.equal(captured.body.questions.selection.instructions, DEFAULT_JEV_PROMPT.instructions);
  assert.equal(captured.body.questions.selection.criteria.abstain, DEFAULT_JEV_PROMPT.abstainCriteria);
  assert.equal(captured.body.questions.selection.criteria["candidate-1"], DEFAULT_JEV_PROMPT.candidateCriteria(1));
});

test("a tuned prompt reaches the wire exactly, without changing candidates or schema keys", async () => {
  const variant = TUNE_VARIANTS[0]!;
  const captured: { body: any } = { body: undefined };
  const client = createTypeSafeJevClient({
    apiKey: "k",
    prompt: variant.prompt,
    fetch: async (_url, init) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: "m", answers: { selection: { type: "choice", choice: "candidate-2", confidence: 0.9 } } }), { status: 200 });
    },
  });
  const result = await client.choose(
    { candidates: [{ ordinal: 1, window: "one" }, { ordinal: 2, window: "two" }], requestedEditText: "replacement" },
    new AbortController().signal,
  );
  assert.equal(result.choice, 2);
  assert.equal(captured.body.questions.selection.instructions, variant.prompt.instructions);
  assert.equal(captured.body.questions.selection.criteria.abstain, variant.prompt.abstainCriteria);
  assert.deepEqual(Object.keys(captured.body.questions.selection.criteria).sort(), ["abstain", "candidate-1", "candidate-2"]);
  assert.deepEqual(captured.body.state.candidates, [{ ordinal: 1, window: "one" }, { ordinal: 2, window: "two" }]);
});

test("runTuneVariant maps selections/abstentions/confidence/latency per tier deterministically", async () => {
  // Scripted responses for the frozen 12 fixtures (tier order). One wrong
  // target in tier 1 (fixture 4 expected ordinal 1, answered 3).
  const script: JevSelectionResponse[] = [
    { choice: 1, confidence: 0.95 },   // t1 f1 -> correct
    { choice: 2, confidence: 0.91 },   // t1 f2 -> correct
    { choice: null, confidence: 0.5 }, // t1 f3 -> abstain
    { choice: 3, confidence: 0.93 },   // t1 f4 -> WRONG (expected 1)
    { choice: null, confidence: 0.6 }, // t2 f1 -> abstain
    { choice: 1, confidence: 0.9 },    // t2 f2 -> correct
    { choice: null, confidence: 0.55 },// t2 f3 -> abstain
    { choice: 3, confidence: 0.92 },   // t2 f4 -> WRONG (expected 1)
    { choice: null, confidence: 0.4 }, // t3 f1 -> abstain
    { choice: 3, confidence: 0.9 },    // t3 f2 -> correct (expected 3)
    { choice: null, confidence: 0.45 },// t3 f3 -> abstain
    { choice: null, confidence: 0.5 }, // t3 f4 -> abstain
  ];
  let tick = 0;
  const now = () => (tick += 7);

  const first = await runTuneVariant({ variant: BASELINE_VARIANT, client: scriptedClient([...script]), now });
  tick = 0;
  const second = await runTuneVariant({ variant: BASELINE_VARIANT, client: scriptedClient([...script]), now });
  assert.deepEqual(second, first, "identical inputs produce identical results");

  const tier1 = first.tiers[0]!;
  assert.equal(tier1.tier, "tier-1-strong-context");
  assert.equal(tier1.selected, 3);
  assert.equal(tier1.correct, 2);
  assert.equal(tier1.wrongTarget, 1);
  assert.equal(tier1.abstained, 1);
  assert.deepEqual(tier1.selectionConfidences, [0.95, 0.91, 0.93]);
  assert.deepEqual(tier1.abstentionConfidences, [0.5]);
  assert.equal(tier1.latencyMs.length, 4);

  const tier2 = first.tiers[1]!;
  assert.equal(tier2.selected, 2);
  assert.equal(tier2.correct, 1);
  assert.equal(tier2.wrongTarget, 1);
  assert.equal(tier2.abstained, 2);

  assert.equal(first.totalSelected, 6);
  assert.equal(first.totalCorrect, 4);
  assert.equal(first.totalWrongTarget, 2);
  assert.equal(first.totalAbstained, 6);
});

test("recommendation: wrong-target rejects, more-correct-with-zero-wrong adopts, else keep", () => {
  const make = (overrides: Partial<VariantResult>): VariantResult => ({
    variantId: "x",
    tiers: [],
    totalSelected: 0,
    totalCorrect: 0,
    totalWrongTarget: 0,
    totalAbstained: 0,
    ...overrides,
  });

  const reject = decideRecommendation([
    make({ variantId: "baseline", totalCorrect: 0 }),
    make({ variantId: "v1", totalCorrect: 3, totalWrongTarget: 1 }),
  ]);
  assert.equal(reject.decision, "reject");
  assert.match(reject.reason, /wrong-target/);

  const adopt = decideRecommendation([
    make({ variantId: "baseline", totalCorrect: 1 }),
    make({ variantId: "v1", totalCorrect: 4, totalWrongTarget: 0 }),
  ]);
  assert.equal(adopt.decision, "adopt-for-shadow-evaluation");

  const keep = decideRecommendation([
    make({ variantId: "baseline", totalCorrect: 2 }),
    make({ variantId: "v1", totalCorrect: 2, totalWrongTarget: 0 }),
  ]);
  assert.equal(keep.decision, "keep");
});

test("the tune report renders byte-identically and carries the governance label", () => {
  const report: TuneReport = {
    label: "direction evidence only",
    baseline: {
      variantId: "baseline",
      tiers: [{
        tier: "tier-1-strong-context", fixtures: 4, selected: 1, correct: 1, wrongTarget: 0,
        abstained: 3, abstentionRate: 0.75, precision: 1, selectionConfidences: [0.97], abstentionConfidences: [0.5, 0.4, 0.3], latencyMs: [120, 130, 110, 140],
      }],
      totalSelected: 1,
      totalCorrect: 1,
      totalWrongTarget: 0,
      totalAbstained: 3,
    },
    variants: [],
    recommendation: { decision: "keep", reason: "no variant improved correct selections over baseline" },
  };
  assert.equal(renderTuneMarkdown(report), renderTuneMarkdown(report));
  assert.equal(renderTuneJson(report), renderTuneJson(report));
  assert.match(renderTuneMarkdown(report), /direction evidence only/);
  assert.match(renderTuneMarkdown(report), /Recommendation: keep/);

  const parsed = JSON.parse(renderTuneJson(report));
  assert.equal(parsed.label, "direction evidence only");
  assert.equal(parsed.baseline.tiers[0].wrongTarget, 0);
});
