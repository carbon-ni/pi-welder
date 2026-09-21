/**
 * TASK-0043 — snapshot-based mining.
 *
 * The miner reads the historical directory snapshot out of a failed read's own
 * error message and never touches the current filesystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PROVISIONAL_LABELS,
  mineTwoFileSelections,
  normalizePath,
  opaqueId,
  parentDirectoryOf,
  parseMissingReadSnapshot,
  summarizeTwoFileMining,
  type SessionInput,
  type SessionReadCall,
  type TwoFileMiningResult,
} from "./two-file-read.ts";

const MISSING_ERROR = "ENOENT: no such file or directory, access '/repo/src/helpers.ts'";
const CWD = "/repo";

/** The exact layout the missing-read-context repair writes. */
function snapshot(root: string, entries: readonly string[], options: { truncated?: boolean } = {}): string {
  const lines = entries.map((entry, index) => `${index === entries.length - 1 ? "└──" : "├──"} ${entry}`);
  return [
    MISSING_ERROR,
    "",
    "Requested path: src/helpers.ts",
    `Tree from: ${root}`,
    ".",
    ...lines,
    ...(options.truncated === true ? ["… tree truncated"] : []),
  ].join("\n");
}

const call = (
  path: string,
  options: { error?: boolean; missing?: boolean; result?: string; detailsTruncated?: boolean } = {},
): SessionReadCall => ({
  identifier: `id:${path}`,
  path,
  isError: options.error === true,
  missing: options.missing === true,
  resultText: options.result ?? "",
  ...(options.detailsTruncated === undefined ? {} : { detailsTruncated: options.detailsTruncated }),
});

const session = (calls: readonly SessionReadCall[], sessionKey = "s1"): SessionInput => ({ sessionKey, cwd: CWD, calls });

test("the snapshot parser reads the direct regular files only", () => {
  const parsed = parseMissingReadSnapshot(snapshot("/repo/src", ["helpers.test.ts", "utils.ts", "nested/"]));
  assert.deepEqual(parsed, { root: "/repo/src", directFiles: ["helpers.test.ts", "utils.ts"], truncated: false });
});

test("the snapshot parser rejects anything it cannot trust", () => {
  assert.equal(parseMissingReadSnapshot("ENOENT: no such file"), undefined, "no snapshot");
  assert.equal(parseMissingReadSnapshot("Tree from: /repo/src\n├── a.ts"), undefined, "missing the . marker");
  assert.equal(parseMissingReadSnapshot("Tree from: \n.\n├── a.ts"), undefined, "empty root");

  const truncated = parseMissingReadSnapshot(snapshot("/repo/src", ["a.ts", "b.ts"], { truncated: true }));
  assert.equal(truncated?.truncated, true, "truncation is reported so the caller can abstain");
});

test("path normalization resolves cwd, dots, and both separator styles", () => {
  assert.equal(normalizePath("src/helpers.ts", "/repo"), "/repo/src/helpers.ts");
  assert.equal(normalizePath("./src/../src/helpers.ts", "/repo"), "/repo/src/helpers.ts");
  assert.equal(normalizePath("src\\helpers.ts", "/repo"), "/repo/src/helpers.ts");
  assert.equal(normalizePath("C:\\repo\\src\\helpers.ts", "C:\\other"), "C:/repo/src/helpers.ts");
  assert.equal(parentDirectoryOf("src/helpers.ts", "/repo"), "/repo/src");
  assert.equal(parentDirectoryOf("helpers.ts", "/repo"), "/repo");
});

test("opaque identifiers cannot collide on naive concatenation", () => {
  assert.equal(opaqueId(["ab", "c"]), opaqueId(["ab", "c"]), "the same parts are stable");
  assert.notEqual(opaqueId(["ab", "c"]), opaqueId(["a", "bc"]), "length framing keeps them distinct");
  assert.notEqual(opaqueId(["s1", "call:1", "/a/b.ts"]), opaqueId(["s1", "call:1", "/a/b.t"]));
  assert.equal(/^[0-9a-f]{32}$/.test(opaqueId(["session.jsonl"])), true);
});

test("an eligible snapshot predicts, and a later read of a candidate observes", () => {
  const result = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/helpers.test.ts"),
    ]),
  ]);

  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.candidateCount, 2);
  assert.equal(record.prediction.reason, "test-spec-counterpart");
  assert.equal(record.prediction.ordinal, 1, "helpers.test.ts sorts first");
  assert.deepEqual(record.observed, { ordinal: 1 });
  assert.equal(record.outcome, "correct");
  assert.equal(JSON.stringify(record).includes("helpers"), false, "no names in the record");
  assert.equal(JSON.stringify(record).includes("/repo"), false, "no paths in the record");
});

test("a selection nobody read is unresolved, not wrong", () => {
  const result = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/unrelated.ts"),
    ]),
  ]);

  assert.equal(result.records[0]!.observed, null);
  assert.equal(result.records[0]!.outcome, "unresolved");
});

test("reading the other candidate is wrong, and the lookahead stays at three calls", () => {
  const wrong = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/utils.ts"),
    ]),
  ]);
  assert.equal(wrong.records[0]!.observed?.ordinal, 2);
  assert.equal(wrong.records[0]!.outcome, "wrong");

  const outOfScope = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/a.ts"), call("src/b.ts"), call("src/c.ts"),
      call("src/helpers.test.ts"),
    ]),
  ]);
  assert.equal(outOfScope.records[0]!.observed, null, "the fourth later read is out of scope");
});

test("an ineligible snapshot never becomes a selection", () => {
  const cases: [string, string][] = [
    ["no snapshot", MISSING_ERROR],
    ["truncated", snapshot("/repo/src", ["helpers.test.ts", "utils.ts"], { truncated: true })],
    ["root mismatch", snapshot("/repo/lib", ["helpers.test.ts", "utils.ts"])],
    ["one direct file", snapshot("/repo/src", ["helpers.test.ts"])],
    ["three direct files", snapshot("/repo/src", ["helpers.test.ts", "utils.ts", "extra.ts"])],
  ];

  for (const [label, result] of cases) {
    const mined = mineTwoFileSelections([session([call("src/helpers.ts", { error: true, missing: true, result })])]);
    assert.equal(mined.records.length, 0, label);
    assert.equal(mined.snapshotIneligible, 1, label);
  }

  const nested = snapshot("/repo/src", ["helpers.test.ts", "utils.ts", "sub/"]);
  const mined = mineTwoFileSelections([session([call("src/helpers.ts", { error: true, missing: true, result: nested })])]);
  assert.equal(mined.records.length, 1, "a subdirectory does not disqualify the two direct files");
});

test("the structured truncation flag disqualifies an otherwise complete snapshot", () => {
  // The real repair sets details.missingReadContext.truncated when the rendered
  // context exceeded its byte budget, which can cut the "… tree truncated"
  // marker out of the content. The structured flag must still disqualify it.
  const complete = snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]);
  assert.equal(complete.includes("truncated"), false, "the content carries no marker");

  const result = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: complete, detailsTruncated: true }),
      call("src/helpers.test.ts"),
    ]),
  ]);

  assert.equal(result.records.length, 0);
  assert.equal(result.snapshotIneligible, 1);

  const withoutFlag = mineTwoFileSelections([
    session([
      call("src/helpers.ts", { error: true, missing: true, result: complete, detailsTruncated: false }),
      call("src/helpers.test.ts"),
    ]),
  ]);
  assert.equal(withoutFlag.records.length, 1, "an explicit false stays eligible");
});

test("a windows-style requested path matches an absolute windows snapshot root", () => {
  const result = mineTwoFileSelections([
    { sessionKey: "s1", cwd: "C:\\repo", calls: [
      call("src\\helpers.ts", { error: true, missing: true, result: snapshot("C:\\repo\\src", ["helpers.test.ts", "utils.ts"]) }),
      call("src\\helpers.test.ts"),
    ] },
  ]);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.outcome, "correct");
});

test("ten selections with one observed read give one label and precision from that label", () => {
  const sessions: SessionInput[] = [];
  for (let index = 0; index < 9; index += 1) {
    sessions.push(session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/unrelated.ts"),
    ], `unresolved-${index}`));
  }
  sessions.push(session([
    call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
    call("src/helpers.test.ts"),
  ], "observed"));

  const summary = summarizeTwoFileMining(mineTwoFileSelections(sessions));

  assert.equal(summary.selections, 10);
  assert.equal(summary.unresolved, 9);
  assert.equal(summary.observedLabels, 1, "only the observed selection is a label");
  assert.equal(summary.labelsCorrect, 1);
  assert.equal(summary.labelsWrong, 0);
  assert.equal(summary.precision, 1, "precision divides by observed labels only");
  assert.equal(summary.sessionConcentration.contributingSessions, 1);
  assert.equal(summary.sessionConcentration.maxLabelsInOneSession, 1);
  assert.equal(summary.insufficient, true, `one label is below ${MIN_PROVISIONAL_LABELS}`);
});

test("wrong observed predictions lower precision, and insufficiency is label-based", () => {
  const sessions: SessionInput[] = [
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/utils.ts"),
    ], "wrong"),
    session([
      call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) }),
      call("src/unrelated.ts"),
    ], "unresolved"),
  ];

  const summary = summarizeTwoFileMining(mineTwoFileSelections(sessions));
  assert.equal(summary.observedLabels, 1);
  assert.equal(summary.labelsWrong, 1);
  assert.equal(summary.precision, 0);
  assert.deepEqual(summary.reasons, [{ reason: "test-spec-counterpart", count: 2 }]);
  assert.equal(summarizeTwoFileMining(mineTwoFileSelections(sessions), 1).insufficient, false);
});

test("the attrition ladder counts empty sessions honestly", () => {
  const mined: TwoFileMiningResult = mineTwoFileSelections([
    { sessionKey: "empty", cwd: CWD, calls: [] },
    session([call("src/helpers.ts", { error: true, missing: true, result: MISSING_ERROR })]),
    session([call("src/helpers.ts", { error: true, missing: true, result: snapshot("/repo/src", ["helpers.test.ts", "utils.ts"]) })], "s3"),
  ]);
  const summary = summarizeTwoFileMining(mined);

  assert.equal(summary.sessionsScanned, 3, "every session file counts, even without reads");
  assert.equal(summary.sessionsWithReads, 2);
  assert.equal(summary.readCalls, 2);
  assert.equal(summary.missingReads, 2);
  assert.equal(summary.snapshotIneligible, 1);
  assert.equal(summary.selections, 1);
  assert.deepEqual(summary.attrition.map((row) => row.stage), [
    "sessions", "sessions-with-reads", "read-calls", "missing-reads",
    "snapshot-eligible", "selections", "observed-labels", "labels-correct",
  ]);
});

test("the summary and records carry no paths, names, identifiers, or contents", () => {
  const mined = mineTwoFileSelections([
    session([
      call("/private/secret/helpers.ts", { error: true, missing: true, result: snapshot("/private/secret", ["helpers.test.ts", "utils.ts"]) }),
      call("/private/secret/helpers.test.ts"),
    ], "session-secret-key"),
  ]);
  const serialized = JSON.stringify({ summary: summarizeTwoFileMining(mined), records: mined.records });

  for (const leak of ["secret", "private", "helpers", "utils", "session-secret-key", MISSING_ERROR]) {
    assert.equal(serialized.includes(leak), false, `evidence leaked ${leak}`);
  }
});
