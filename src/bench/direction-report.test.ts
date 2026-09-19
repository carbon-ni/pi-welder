import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderDirectionJson,
  renderDirectionMarkdown,
  type DirectionReport,
} from "./direction-report.ts";

function fixtureReport(): DirectionReport {
  return {
    label: "direction evidence only",
    baselines: [
      {
        population: "P1",
        episodes: 40,
        candidate: "B0-no-message",
        score: 0.5,
        observed: 38,
        successes: 19,
        expired: 2,
        byOutcome: { valid: 19, "repaired-recurrence": 19 },
      },
    ],
    yield: {
      label: "direction evidence only",
      total: 3,
      resolved: 2,
      matchedExpectations: 3,
      rules: [
        { rule: "parse-json", eligibleFixtures: 1, fired: 1, yieldRate: 1 },
        { rule: "wrap-array", eligibleFixtures: 0, fired: 0, yieldRate: 0 },
      ],
      deadRules: ["wrap-array"],
    },
    probe: {
      totalFixtures: 12,
      tiers: [
        { tier: "tier-1-strong-context", fixtures: 4 },
        { tier: "tier-2-weak-context", fixtures: 4 },
        { tier: "tier-3-genuinely-ambiguous", fixtures: 4 },
      ],
      executed: false,
      tierResults: [
        {
          tier: "tier-1-strong-context",
          fixtures: 4,
          selectorId: "offline-similarity",
          selected: 4,
          correct: 3,
          wrong: 1,
          abstained: 0,
          abstentionRate: 0,
          precision: 0.75,
        },
      ],
    },
  };
}

test("the direction report renders byte-identically for identical inputs", () => {
  const report = fixtureReport();
  assert.equal(renderDirectionMarkdown(report), renderDirectionMarkdown(fixtureReport()));
  assert.equal(renderDirectionJson(report), renderDirectionJson(fixtureReport()));
});

test("the report carries the governance label, dead rules, and probe gating", () => {
  const markdown = renderDirectionMarkdown(fixtureReport());
  assert.match(markdown, /direction evidence only/);
  assert.match(markdown, /Dead rules .*wrap-array/);
  assert.match(markdown, /not executed \(gated behind --execute\)/);
  assert.match(markdown, /tier-3-genuinely-ambiguous/);

  const json = JSON.parse(renderDirectionJson(fixtureReport()));
  assert.equal(json.label, "direction evidence only");
  assert.equal(json.probe.executed, false);
  assert.equal(json.yield.deadRules[0], "wrap-array");
});

test("an executed probe reports itself as executed", () => {
  const report = fixtureReport();
  report.probe.executed = true;
  assert.match(renderDirectionMarkdown(report), /real-API probe executed/);
});
