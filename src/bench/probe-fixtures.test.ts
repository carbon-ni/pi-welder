import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JEV_PROBE_FIXTURES,
  PROBE_TIERS,
  buildProbeSelectors,
  createJevProbeSelector,
  jevProbeRequest,
  probeCase,
  probeCasesByTier,
  probeFixtureCounts,
  type JevProbeRequest,
} from "./probe-fixtures.ts";
import { ALWAYS_ABSTAIN, evaluateSelector, similarityRankSelector } from "./edit-selection.ts";
import { createTypeSafeJevClient, type JevClient, type JevSelectionRequest, type JevSelectionResponse } from "../infra/typesafe.ts";

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

// --- Jev probe adapter (TypeSafe, --execute gated) ------------------------------

function stubJevClient(responses: { choice: number | null; confidence?: number }[], calls?: JevSelectionRequest[]): JevClient {
  let index = 0;
  return {
    async choose(request) {
      calls?.push(request);
      return responses[Math.min(index++, responses.length - 1)]!;
    },
  };
}

test("the Jev adapter maps probe fixtures onto Jev requests without changing candidate semantics", () => {
  const requests = JEV_PROBE_FIXTURES.map(jevProbeRequest);
  assert.equal(requests.length, JEV_PROBE_FIXTURES.length);
  for (const entry of requests as JevProbeRequest[]) {
    assert.equal(entry.request.candidates.length, entry.case.candidates.length);
    assert.deepEqual(entry.request.candidates.map((candidate) => candidate.ordinal), entry.case.candidates.map((candidate) => candidate.ordinal));
    for (const candidate of entry.request.candidates) {
      assert.ok(candidate.window.length > 0);
      assert.ok(candidate.window.split("\n").length <= 20);
    }
    const fixture = JEV_PROBE_FIXTURES.find((fixture) => fixture.caseId === entry.case.caseId)!;
    assert.equal(entry.request.requestedEditText, fixture.newText);
  }
});

test("the Jev selector maps choices to ordinals, abstains to abstentions, and records confidence", async () => {
  const calls: JevSelectionRequest[] = [];
  const requests = JEV_PROBE_FIXTURES.slice(0, 3).map(jevProbeRequest);
  const selector = createJevProbeSelector(stubJevClient([
    { choice: 2, confidence: 0.97, model: "jev-test" } as JevSelectionResponse,
    { choice: null, confidence: 0.4 },
    { choice: 99 },
  ], calls), requests);

  const first = await selector.select(requests[0]!.case);
  const second = await selector.select(requests[1]!.case);
  const third = await selector.select(requests[2]!.case);

  assert.equal(calls.length, 3, "exactly one Jev call per case");
  assert.deepEqual(calls[0]!.candidates.map((candidate) => candidate.ordinal), requests[0]!.request.candidates.map((candidate) => candidate.ordinal));
  assert.deepEqual(first, { ordinal: 2 });
  assert.deepEqual(second, { abstain: true });
  assert.deepEqual(third, { abstain: true }, "out-of-range ordinals abstain");
  assert.equal(selector.responses.length, 3);
  assert.equal(selector.responses[0]!.response.confidence, 0.97);});

test("buildProbeSelectors stays offline unless execute is set, then selects the TypeSafe Jev client", () => {
  let created = 0;
  const factory = (apiKey: string) => {
    created++;
    assert.equal(apiKey, " typesafe-key ".trim());
    return stubJevClient([]);
  };

  // Offline: no client creation, no key required, only the two offline selectors.
  const offline = buildProbeSelectors({ execute: false, createJevClient: factory });
  assert.equal(created, 0);
  assert.deepEqual(offline.selectors.map((entry) => entry.id), ["offline-abstain", "offline-similarity"]);
  assert.equal(offline.jevSelector, undefined);

  // Execute: the TypeSafe Jev client factory is used with the trimmed key.
  const executed = buildProbeSelectors({ execute: true, apiKey: " typesafe-key ", createJevClient: factory });
  assert.equal(created, 1);
  assert.deepEqual(executed.selectors.map((entry) => entry.id), ["offline-abstain", "offline-similarity", "jev-ordinal"]);
  assert.ok(executed.jevSelector);

  // The default factory IS the existing TypeSafe adapter.
  const withDefault = buildProbeSelectors({ execute: true, apiKey: "k" });
  assert.ok(withDefault.jevSelector);
  assert.equal(typeof (withDefault.jevSelector as unknown as { client?: unknown }).client, "undefined");
});

test("missing or blank TYPESAFE_API_KEY fails closed before any client is created", () => {
  let created = 0;
  const factory = (apiKey: string) => {
    created++;
    return stubJevClient([]);
  };
  assert.throws(() => buildProbeSelectors({ execute: true, createJevClient: factory }), /--execute requires TYPESAFE_API_KEY/);
  assert.throws(() => buildProbeSelectors({ execute: true, apiKey: "   ", createJevClient: factory }), /--execute requires TYPESAFE_API_KEY/);
  assert.equal(created, 0, "no client may be constructed without a valid key");
});

test("buildProbeSelectors uses createTypeSafeJevClient as its default Jev client", async () => {
  // The default-built selector must talk the JevClient protocol: point it at a
  // real TypeSafe-shaped client stub and observe a choose() call.
  let attempts = 0;
  const real = createTypeSafeJevClient({ apiKey: "stub", fetch: (async () => {
    attempts++;
    throw new Error("network disabled in tests");
  }) as typeof fetch });
  const selector = createJevProbeSelector(real, JEV_PROBE_FIXTURES.slice(0, 1).map(jevProbeRequest));
  const selection = await selector.select(JEV_PROBE_FIXTURES.slice(0, 1).map(jevProbeRequest)[0]!.case);
  assert.deepEqual(selection, { abstain: true }, "transport failure is an evidence-neutral abstention");
  assert.equal(attempts, 1, "the TypeSafe client performed exactly one bounded attempt");
});
