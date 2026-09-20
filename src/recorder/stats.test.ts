/**
 * TASK-0039 — stats categories stay separate:
 * input repairs, verified result recoveries, and diagnostic enrichments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStats,
  recordEnrichment,
  recordRecovery,
  recordRepairs,
  recordResultRepairStats,
  statsSummary,
} from "./stats.ts";

const repair = (action: string) => ({ field: "path", action });

test("diagnostic enrichment is never counted as a repair", () => {
  const stats = createStats();

  recordEnrichment(stats, [repair("missing-read-context") as any]);

  assert.equal(stats.enrichedResults, 1);
  assert.equal(stats.enrichmentsByAction.get("missing-read-context"), 1);
  assert.equal(stats.repairedToolCalls, 0, "no input was transformed");
  assert.equal(stats.repairsByAction.size, 0);
  assert.equal(stats.recoveredResults, 0);
});

test("verified result recovery is separate from input repairs", () => {
  const stats = createStats();

  recordRecovery(stats, [repair("edit-noop") as any]);
  recordRepairs(stats, [repair("restore-read-path") as any]);

  assert.equal(stats.recoveredResults, 1);
  assert.equal(stats.recoveriesByAction.get("edit-noop"), 1);
  assert.equal(stats.repairedToolCalls, 1, "only the input repair counts here");
  assert.deepEqual([...stats.repairsByAction.keys()], ["restore-read-path"]);
  assert.equal(stats.enrichedResults, 0);
});

test("one result patch is folded into exactly one category", () => {
  const enrichment = createStats();
  recordResultRepairStats(enrichment, [repair("missing-read-context") as any]);
  assert.equal(enrichment.enrichedResults, 1);
  assert.equal(enrichment.recoveredResults, 0, "enrichment is not a recovery");

  const recovery = createStats();
  recordResultRepairStats(recovery, [repair("edit-noop") as any, repair("directory-read") as any]);
  assert.equal(recovery.recoveredResults, 1);
  assert.equal(recovery.recoveriesByAction.get("edit-noop"), 1);
  assert.equal(recovery.recoveriesByAction.get("directory-read"), 1);
  assert.equal(recovery.enrichedResults, 0);

  const empty = createStats();
  recordResultRepairStats(empty, []);
  assert.equal(empty.recoveredResults, 0);
  assert.equal(empty.enrichedResults, 0);
});

test("statsSummary renders repairs, recoveries, and enrichments as separate sections", () => {
  const stats = createStats();
  stats.totalToolCalls = 4;
  recordRepairs(stats, [repair("route-to-bash") as any]);
  recordRecovery(stats, [repair("edit-noop") as any]);
  recordEnrichment(stats, [repair("missing-read-context") as any]);

  const out = statsSummary(stats);

  assert.match(out, /calls repaired  : 1/);
  assert.match(out, /by repair action \(input transformed or routed\):[\s\S]*route-to-bash\s+1\s+100%/);
  assert.match(out, /result recoveries \(verified patch, input unchanged\):[\s\S]*recovered results : 1[\s\S]*edit-noop\s+1\s+100%/);
  assert.match(out, /diagnostic enrichments \(context only, never a repair\):[\s\S]*enriched results  : 1[\s\S]*missing-read-context\s+1\s+100%/);

  // Categories never leak into each other's sections.
  const repairsSection = out.slice(out.indexOf("by repair action"), out.indexOf("result recoveries"));
  assert.equal(repairsSection.includes("missing-read-context"), false);
  assert.equal(repairsSection.includes("edit-noop"), false);
  const recoverySection = out.slice(out.indexOf("result recoveries"), out.indexOf("diagnostic enrichments"));
  assert.equal(recoverySection.includes("missing-read-context"), false);
});

test("statsSummary is explicit when a category is empty", () => {
  const out = statsSummary(createStats());

  assert.match(out, /result recoveries \(verified patch, input unchanged\):\n\s+none/);
  assert.match(out, /diagnostic enrichments \(context only, never a repair\):\n\s+none/);
});
