import { test } from "node:test";
import assert from "node:assert/strict";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  INSTINCT_FIXTURES,
  buildYieldReport,
  runFixtureSuite,
  type FixtureRun,
} from "./instincts.ts";
import { REPAIR_ACTIONS } from "../repairs/types.ts";

async function withFixtureRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-instincts-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("every fixture resolves exactly as declared against the real pipeline", async () => {
  await withFixtureRoot(async (root) => {
    const runs = await runFixtureSuite(INSTINCT_FIXTURES, root);
    assert.equal(runs.length, INSTINCT_FIXTURES.length);
    const mismatches = runs.filter((run) => !run.matchesExpectation);
    assert.deepEqual(mismatches.map((run) => ({ id: run.fixtureId, actions: run.actions, resolved: run.resolved })), []);
  });
});

test("identical runs produce identical yields (determinism)", async () => {
  await withFixtureRoot(async (firstRoot) => {
    await withFixtureRoot(async (secondRoot) => {
      const first = await runFixtureSuite(INSTINCT_FIXTURES, firstRoot);
      const second = await runFixtureSuite(INSTINCT_FIXTURES, secondRoot);
      assert.deepEqual(second, first);
      assert.deepEqual(buildYieldReport(INSTINCT_FIXTURES, second), buildYieldReport(INSTINCT_FIXTURES, first));
    });
  });
});

test("negative controls stay unrepaired: identical ambiguity and stale drift fail cleanly", async () => {
  await withFixtureRoot(async (root) => {
    const runs = await runFixtureSuite(INSTINCT_FIXTURES, root);
    const byId = new Map(runs.map((run) => [run.fixtureId, run]));
    assert.deepEqual(byId.get("edit-ambiguous-multiple-viable")!.actions, []);
    assert.equal(byId.get("edit-ambiguous-multiple-viable")!.resolved, false);
    assert.deepEqual(byId.get("edit-drift-stale")!.actions, []);
    assert.equal(byId.get("edit-drift-stale")!.resolved, false);
  });
});

test("yield report covers every active rule and flags never-fired rules as dead", async () => {
  await withFixtureRoot(async (root) => {
    const runs = await runFixtureSuite(INSTINCT_FIXTURES, root);
    const report = buildYieldReport(INSTINCT_FIXTURES, runs);

    assert.equal(report.label, "direction evidence only");
    assert.equal(report.total, INSTINCT_FIXTURES.length);
    assert.equal(report.rules.length, REPAIR_ACTIONS.length);
    for (const rule of report.rules) {
      assert.ok(rule.fired <= rule.eligibleFixtures || rule.eligibleFixtures === 0, `${rule.rule} fired more than eligible`);
      if (rule.eligibleFixtures > 0) assert.ok(rule.yieldRate > 0 && rule.yieldRate <= 1);
    }
    // Every fired action belongs to the active rule set.
    const active = new Set<string>(REPAIR_ACTIONS);
    for (const run of runs) assert.ok(run.actions.every((action) => active.has(action)));
    // Dead rules are exactly those that never fired.
    const fired = new Set(runs.flatMap((run) => run.actions as string[]));
    assert.deepEqual(report.deadRules, REPAIR_ACTIONS.filter((rule) => !fired.has(rule)));
  });
});

test("fixtures are sanitized: no absolute homes, secrets, or credential shapes", () => {
  const serialized = JSON.stringify(INSTINCT_FIXTURES);
  assert.doesNotMatch(serialized, /\/(Users|home)\//);
  assert.doesNotMatch(serialized, /\b(sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/u);
  assert.doesNotMatch(serialized, /-----BEGIN [^-]+-----/);
  assert.doesNotMatch(serialized, /\b(api[_-]?key|password|secret)\b\s*[:=]/iu);
  // All workspace paths are relative and generic.
  for (const fixture of INSTINCT_FIXTURES) {
    for (const relativePath of Object.keys(fixture.files ?? {})) {
      assert.ok(!path.isAbsolute(relativePath), `${fixture.fixtureId} uses an absolute path`);
      assert.doesNotMatch(relativePath, /\.\./);
    }
  }
});
