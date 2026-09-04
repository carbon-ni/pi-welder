import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SYNTHETIC_TRAINSET,
  searchTemplates,
  evaluateWithModel,
  generateTemplateMessage,
  runLabSmoke,
  validateCandidateMessage,
  type TemplateParams,
  type ModelClient,
} from "./lab.ts";

const CLOCKS = {
  fixed: () => ({ now: () => 1_000 }),
  stepping: (stepMs: number) => {
    let t = 0;
    return { now: () => (t += stepMs) };
  },
};

test("synthetic trainset is zero-content and structurally eligible", () => {
  assert.ok(SYNTHETIC_TRAINSET.length >= 3);
  const serialized = JSON.stringify(SYNTHETIC_TRAINSET);
  for (const field of ["errorText", '"content"', '"command":', "oldText", "newText", '"path":', "prompt"]) {
    assert.ok(!serialized.includes(field), `trainset must not contain ${field}`);
  }
  assert.ok(SYNTHETIC_TRAINSET.every((episode) => episode.repairs.length > 0));
});

test("generated messages always reference episode actions and stay eligible", () => {
  const episode = SYNTHETIC_TRAINSET[0]!;
  const params: TemplateParams = { header: "hint", bullet: "dash", includeKeys: true, includeWhy: true };
  const message = generateTemplateMessage(params, episode);
  assert.ok(message.includes(episode.repairs[0]!));
  assert.ok(message.length <= 480);
});

test("seeded search is reproducible: same seed, same candidates and best", () => {
  const first = searchTemplates(SYNTHETIC_TRAINSET, { seed: 42, maxCandidates: 6 });
  const second = searchTemplates(SYNTHETIC_TRAINSET, { seed: 42, maxCandidates: 6 });
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.best, second.best);
  assert.equal(first.seed, 42);
  assert.equal(first.stoppedBy, "completed");
});

test("search respects the candidate budget and counts evaluations", () => {
  const result = searchTemplates(SYNTHETIC_TRAINSET, { seed: 7, maxCandidates: 5 });
  assert.equal(result.candidates.length, 5);
  assert.equal(result.evaluations, 5);
  assert.equal(result.calls, 0);
  assert.equal(result.tokens, 0);
  assert.equal(result.costUsd, 0);
});

test("deterministic search finds an eligible message at least as valid as the static baseline", () => {
  const result = searchTemplates(SYNTHETIC_TRAINSET, { seed: 42 });
  assert.ok(result.best);
  assert.ok(result.best.score >= result.staticBaseline.score);
  // Tie-break on brevity: search message is not longer than the shipped text.
  assert.ok(result.best.avgLength <= result.staticBaseline.avgLength);
});

test("cancellation stops the search early with a reason", () => {
  let checks = 0;
  const result = searchTemplates(SYNTHETIC_TRAINSET, {
    seed: 1,
    maxCandidates: 8,
    shouldStop: () => (checks++, checks > 2),
  });
  assert.equal(result.stoppedBy, "cancelled");
  assert.ok(result.evaluations < 8);
});

test("timeout uses the injected clock and stops with a reason", () => {
  const result = searchTemplates(SYNTHETIC_TRAINSET, {
    seed: 1,
    maxCandidates: 8,
    clock: CLOCKS.stepping(100),
    timeoutMs: 250,
  });
  assert.equal(result.stoppedBy, "timeout");
  assert.ok(result.evaluations < 8);
});

test("generic templates are structurally ineligible and score zero", () => {
  const episode = SYNTHETIC_TRAINSET[0]!;
  const generic = "let's try reading the file again";
  const violation = validateCandidateMessage({ kind: "repair-warning", repairs: episode.repairs }, generic);
  assert.equal(violation, "generic-recovery");
  // The search space itself cannot produce ineligible messages: every
  // generated message passes validation.
  for (const candidate of searchTemplates(SYNTHETIC_TRAINSET, { seed: 3 }).candidates) {
    for (const episode2 of SYNTHETIC_TRAINSET) {
      assert.equal(validateCandidateMessage({ kind: episode2.kind, repairs: episode2.repairs }, generateTemplateMessage(candidate.params, episode2)), null);
    }
  }
});

const fakeModel: ModelClient = {
  async complete() {
    return { content: JSON.stringify({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }), tokens: 20, latencyMs: 4, provider: "fake", model: "fake-model" };
  },
};

test("fake-LM evaluation is deterministic and exposes scores, tokens, and cost", async () => {
  const params: TemplateParams = { header: "hint", bullet: "dash", includeKeys: false, includeWhy: false };
  const first = await evaluateWithModel(params, SYNTHETIC_TRAINSET, fakeModel, {
    timeoutMs: 1000,
    retryCap: 1,
    concurrencyCap: 2,
    costBudgetUsd: 1,
    usdPerToken: 0.001,
  });
  const second = await evaluateWithModel(params, SYNTHETIC_TRAINSET, fakeModel, {
    timeoutMs: 1000,
    retryCap: 1,
    concurrencyCap: 2,
    costBudgetUsd: 1,
    usdPerToken: 0.001,
  });

  assert.deepEqual(first, second);
  assert.equal(first.tokens, 80);
  assert.equal(first.calls, 4);
  assert.equal(first.costUsd, 0.08);
  assert.equal(first.score, 1);
  assert.equal(first.provider, "fake");
});

test("lab smoke without credentials does not run; with fake client writes ignored report", async () => {
  const none = await runLabSmoke({ apiKey: "" });
  assert.equal(none.ran, false);
  assert.equal(none.reason, "missing-credentials");

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "welder-lab-"));
  const reportPath = path.join(root, "lab-report.md");
  const result = await runLabSmoke({ client: fakeModel, reportPath });

  assert.equal(result.ran, true);
  assert.equal(result.reportPath, reportPath);
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /seed: 42/);
  assert.match(report, /static-baseline/);
  assert.match(report, /fake-model/);
  assert.match(report, /text-json/);
});
