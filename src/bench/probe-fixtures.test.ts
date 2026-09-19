import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JEV_PROBE_FIXTURES,
  PROBE_TIERS,
  probeCase,
  probeCasesByTier,
  probeFixtureCounts,
} from "./probe-fixtures.ts";
import { ALWAYS_ABSTAIN, evaluateSelector, similarityRankSelector } from "./edit-selection.ts";

test("every probe fixture yields a valid 2-5 candidate case with an in-range known ordinal", () => {
  for (const fixture of JEV_PROBE_FIXTURES) {
    const probe = probeCase(fixture);
    assert.ok(probe.candidates.length >= 2 && probe.candidates.length <= 5, fixture.caseId);
    assert.equal(probe.expectedOrdinal, fixture.expectedOrdinal);
    assert.ok(probe.expectedOrdinal >= 1 && probe.expectedOrdinal <= probe.candidates.length, fixture.caseId);
    assert.equal(probe.content, fixture.content);
  }
});

test("tier coverage is four fixtures per tier with deterministic grouping", () => {
  const counts = probeFixtureCounts();
  assert.deepEqual(counts, {
    "tier-1-strong-context": 4,
    "tier-2-weak-context": 4,
    "tier-3-genuinely-ambiguous": 4,
  });
  const grouped = probeCasesByTier();
  assert.deepEqual(grouped.map((group) => group.tier), [...PROBE_TIERS]);
  assert.deepEqual(grouped.map((group) => group.cases.length), [4, 4, 4]);
  assert.deepEqual(probeCasesByTier(), probeCasesByTier());
});

test("tier separation is real: tier-1 candidates have distinct indents, tier-3 do not", () => {
  const grouped = probeCasesByTier();
  const [tier1, , tier3] = grouped;
  for (const probeCaseItem of tier1!.cases) {
    const indents = new Set(probeCaseItem.candidates.map((candidate) => candidate.indent));
    assert.equal(indents.size, probeCaseItem.candidates.length, `${probeCaseItem.caseId}: indents must be unique`);
  }
  for (const probeCaseItem of tier3!.cases) {
    const indents = new Set(probeCaseItem.candidates.map((candidate) => candidate.indent));
    assert.equal(indents.size, 1, `${probeCaseItem.caseId}: indents must be identical`);
  }
});

test("offline selectors run through the existing eval contract deterministically", async () => {
  const grouped = probeCasesByTier();
  const allCases = grouped.flatMap((group) => group.cases);

  const abstain = await evaluateSelector(allCases, ALWAYS_ABSTAIN);
  assert.equal(abstain.abstentionRate, 1);
  assert.equal(abstain.selected, 0);

  const similarity = await evaluateSelector(allCases, similarityRankSelector());
  assert.equal(similarity.selectorId, "similarity-rank");
  assert.equal(similarity.total, JEV_PROBE_FIXTURES.length);

  const rerun = await evaluateSelector(allCases, similarityRankSelector());
  assert.deepEqual(rerun, similarity);
});

test("probe fixtures are sanitized: no absolute homes or credential shapes", () => {
  const serialized = JSON.stringify(JEV_PROBE_FIXTURES);
  assert.doesNotMatch(serialized, /\/(Users|home)\//);
  assert.doesNotMatch(serialized, /\b(sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/u);
});
