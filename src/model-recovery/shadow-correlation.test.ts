import { test } from "node:test";
import assert from "node:assert/strict";

import { uniqueCandidateAcrossSelections, uniqueMatch } from "./shadow-correlation.ts";

test("uniqueCandidateAcrossSelections counts candidates globally, not per selection", () => {
  const c1 = { candidates: [{ ordinal: 1, window: "x" }, { ordinal: 2, window: "x" }] };
  const c2 = { candidates: [{ ordinal: 1, window: "x" }, { ordinal: 2, window: "y" }] };

  // Kelly's counterexample: 3 global matches -> no correlation.
  assert.equal(uniqueCandidateAcrossSelections([c1, c2], "x"), undefined);
  // "y" matches exactly one candidate globally -> correlated to c2.
  assert.deepEqual(uniqueCandidateAcrossSelections([c1, c2], "y"), { selection: c2, candidate: { ordinal: 2, window: "y" } });
  assert.equal(uniqueCandidateAcrossSelections([c1, c2], "z"), undefined);
});

test("uniqueMatch returns the single match or undefined", () => {
  const items = ["a", "b", "a"];
  assert.equal(uniqueMatch(items, (item) => item === "b"), "b");
  assert.equal(uniqueMatch(items, (item) => item === "a"), undefined);
  assert.equal(uniqueMatch(items, () => false), undefined);
});
