import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DISTANCE_RATIO,
  MIN_PROVISIONAL_LABELS,
  distanceRatio,
  extensionOf,
  isMissingError,
  isTestOrSpecName,
  mineTwoFileSelections,
  normalizeFileName,
  selectTwoFileCandidate,
  summarizeTwoFileMining,
  type SessionReadCall,
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

const call = (path: string, isError = false, missing = false): SessionReadCall => ({
  identifier: `id:${path}`,
  path,
  isError,
  missing,
});

test("only a later successful read of the selected file produces a label", () => {
  // The requested file is missing, so it is never in the listing. The pair is a
  // test/spec counterpart, so the heuristic selects the test file.
  const listing = () => ["helpers.test.ts", "utils.ts"];
  const sessions = [
    { sessionKey: "s1", calls: [call("src/helpers.ts", true, true), call("src/helpers.test.ts", false)] },
    { sessionKey: "s2", calls: [call("src/helpers.ts", true, true), call("src/utils.ts", false)] },
    { sessionKey: "s3", calls: [call("src/helpers.ts", true, true), call("src/helpers.test.ts", true, false)] },
  ];
  const mined = mineTwoFileSelections(sessions, listing);

  assert.equal(mined.missingReads, 3);
  assert.equal(mined.episodes.length, 3);
  assert.equal(mined.episodes[0]!.labelledCorrect, true, "the later read matches the selection");
  assert.equal(mined.episodes[1]!.selected, true);
  assert.equal(mined.episodes[1]!.labelledCorrect, false, "a different file is not a label");
  assert.equal(mined.episodes[2]!.labelledCorrect, false, "an errored later read is not a label");
});

test("the lookahead is bounded to three read calls", () => {
  const sessions = [
    {
      sessionKey: "s1",
      calls: [
        call("src/helpers.ts", true, true),
        call("src/unrelated-1.ts", false),
        call("src/unrelated-2.ts", false),
        call("src/unrelated-3.ts", false),
        call("src/helpers.ts", false),
      ],
    },
  ];
  const mined = mineTwoFileSelections(sessions, () => ["helpers.ts", "helpers.test.ts"]);
  assert.equal(mined.episodes[0]!.labelledCorrect, false, "the fourth later read is out of scope");
});

test("scope attrition counts every non-two-file directory", () => {
  const sessions = [
    { sessionKey: "s1", calls: [call("src/helpers.ts", true, true)] },
    { sessionKey: "s2", calls: [call("lib/x.ts", true, true)] },
  ];
  const listings: Record<string, string[]> = { src: ["helpers.ts", "helpers.test.ts"], lib: ["x.ts"] };
  const mined = mineTwoFileSelections(sessions, (directory) => listings[directory]);

  assert.equal(mined.missingReads, 2);
  assert.equal(mined.ineligibleScope, 1);
  assert.equal(mined.episodes.length, 1);
});

test("the summary reports attrition, precision, reasons, concentration, and insufficiency", () => {
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    sessionKey: `s${index}`,
    calls: [call("src/helpers.ts", true, true), call("src/helpers.test.ts", false)],
  }));
  const mined = mineTwoFileSelections(sessions, () => ["helpers.test.ts", "utils.ts"]);
  const summary = summarizeTwoFileMining(mined, sessions.length);

  assert.equal(summary.sessionsScanned, 4);
  assert.equal(summary.readCalls, 8);
  assert.equal(summary.missingReads, 4);
  assert.equal(summary.selections, 4);
  assert.equal(summary.labels, 4);
  assert.equal(summary.labelsCorrect, 4);
  assert.equal(summary.precision, 1);
  assert.deepEqual(summary.attrition.map((row) => row.stage), [
    "sessions", "read-calls", "missing-reads", "exact-two-files", "selections", "labelled-by-later-read",
  ]);
  assert.deepEqual(summary.reasons, [{ reason: "test-spec-counterpart", count: 4 }]);
  assert.deepEqual(summary.sessionConcentration, { contributingSessions: 4, maxLabelsInOneSession: 1 });
  assert.equal(summary.insufficient, true, `only ${MIN_PROVISIONAL_LABELS} labels clear the bar`);

  const concentrated = summarizeTwoFileMining(mined, sessions.length, 4);
  assert.equal(concentrated.insufficient, false);
});

test("abstaining episodes are counted separately from selections", () => {
  const sessions = [{ sessionKey: "s1", calls: [call("src/AGENTS.md", true, true)] }];
  const mined = mineTwoFileSelections(sessions, () => ["auto-helpers.ts", "notes.md"]);
  const summary = summarizeTwoFileMining(mined, 1);

  assert.equal(summary.selections, 0);
  assert.equal(summary.abstentions, 1);
  assert.equal(summary.precision, undefined);
  assert.deepEqual(summary.reasons, [{ reason: "distance-too-far", count: 1 }]);
  assert.equal(summary.insufficient, true);
});

test("the summary carries no paths, names, identifiers, or contents", () => {
  const sessions = [{ sessionKey: "session-secret-key", calls: [call("/private/secret/helpers.ts", true, true), call("/private/secret/helpers.ts", false)] }];
  const mined = mineTwoFileSelections(sessions, () => ["helpers.ts", "helpers.test.ts"]);
  const serialized = JSON.stringify(summarizeTwoFileMining(mined, 1));

  for (const leak of ["secret", "helpers", "session-secret-key", "/private"]) {
    assert.equal(serialized.includes(leak), false, `summary leaked ${leak}`);
  }
});
