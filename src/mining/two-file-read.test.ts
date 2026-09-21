import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DISTANCE_RATIO,
  MIN_PROVISIONAL_LABELS,
  distanceRatio,
  extensionOf,
  isMissingError,
  isTestOrSpecName,
  normalizeFileName,
  selectTwoFileCandidate,
} from "./two-file-read.ts";

test("normalization folds case, separators, and test markers", () => {
  assert.equal(normalizeFileName("Auto-Helpers.ts"), "autohelpers");
  assert.equal(normalizeFileName("auto_helpers.test.ts"), "autohelpers");
  assert.equal(normalizeFileName("foo.spec.js"), "foo");
  assert.equal(isTestOrSpecName("foo.test.ts"), true);
  assert.equal(isTestOrSpecName("foo_test.go"), true);
  assert.equal(isTestOrSpecName("test_foo.py"), true);
  assert.equal(isTestOrSpecName("foo.spec.ts"), true);
  assert.equal(isTestOrSpecName("contest.ts"), false, "no substring-only match");
  assert.equal(extensionOf("a/b/Foo.TS"), "ts");
  assert.equal(extensionOf("Makefile"), "");
});

test("an explicit test/spec pair selects the counterpart in both directions", () => {
  const implementationFirst = selectTwoFileCandidate("helpers.ts", ["helpers.ts", "helpers.test.ts"]);
  assert.deepEqual(implementationFirst, { action: "select", file: "helpers.test.ts", reason: "test-spec-counterpart" });

  const testFirst = selectTwoFileCandidate("helpers.test.ts", ["helpers.ts", "helpers.test.ts"]);
  assert.deepEqual(testFirst, { action: "select", file: "helpers.ts", reason: "test-spec-counterpart" });
});

test("the same stem with a different extension selects the variant", () => {
  assert.deepEqual(selectTwoFileCandidate("config.js", ["config.ts", "notes.md"]), {
    action: "select",
    file: "config.ts",
    reason: "stem-extension-variant",
  });
});

test("a unique close name selects only with a clear margin", () => {
  // A one-character typo in the stem, with the alternative far away.
  assert.deepEqual(selectTwoFileCandidate("candidate.tsx", ["candidates.ts", "engine.ts"]), {
    action: "select",
    file: "candidates.ts",
    reason: "unique-distance",
  });
});

test("an unrelated pair abstains: AGENTS.md never selects auto-helpers", () => {
  const selection = selectTwoFileCandidate("AGENTS.md", ["auto-helpers.ts", "notes.md"]);
  assert.equal(selection.action, "abstain");
  assert.equal(selection.reason, "distance-too-far");
  assert.ok(distanceRatio(normalizeFileName("AGENTS.md"), normalizeFileName("auto-helpers.ts")) > MAX_DISTANCE_RATIO);
});

test("an extension match alone never selects", () => {
  assert.equal(selectTwoFileCandidate("report.ts", ["dataset.ts", "runner.ts"]).action, "abstain");
  assert.equal(extensionOf("report.ts"), extensionOf("dataset.ts"), "the extensions do match");
});

test("equidistant candidates abstain as ambiguous, far ones as too far", () => {
  assert.deepEqual(selectTwoFileCandidate("abcd.ts", ["abce.ts", "abcf.ts"]), { action: "abstain", reason: "ambiguous-distance" });
  assert.deepEqual(selectTwoFileCandidate("ab.ts", ["ac.ts", "ad.ts"]), { action: "abstain", reason: "distance-too-far" });
});

test("anything other than exactly two files never selects", () => {
  assert.equal(selectTwoFileCandidate("a.ts", ["a.ts"]).action, "abstain");
  assert.equal(selectTwoFileCandidate("a.ts", ["a.ts", "b.ts", "c.ts"]).action, "abstain");
  assert.equal(selectTwoFileCandidate("a.ts", []).action, "abstain");
});

test("missing-file detection is about absence, not every error", () => {
  assert.equal(isMissingError("ENOENT: no such file or directory, access '/x/y.ts'"), true);
  assert.equal(isMissingError("EISDIR: illegal operation on a directory"), false);
  assert.equal(isMissingError("EACCES: permission denied"), false);
});
