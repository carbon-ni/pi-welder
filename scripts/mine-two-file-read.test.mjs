/**
 * TASK-0043 — end-to-end miner test on a synthetic session corpus.
 *
 * Runs the real command, so the JSON evidence shape, the empty-session counting,
 * and the privacy promise are all exercised as shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mine-two-file-read.ts");

const snapshotText = [
  "ENOENT: no such file or directory, access '/repo/src/helpers.ts'",
  "",
  "Requested path: src/helpers.ts",
  "Tree from: /repo/src",
  ".",
  "├── helpers.test.ts",
  "└── utils.ts",
].join("\n");

const lines = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

async function withCorpus(run) {
  const root = await mkdtemp(path.join(tmpdir(), "welder-miner-"));
  const workspace = path.join(root, "ws-a");
  await mkdir(workspace, { recursive: true });

  await writeFile(path.join(workspace, "session-with-read.jsonl"), lines([
    { type: "session", id: "01a0bebc-1c5e-7942-8f3a-6cbc7cb9f897", cwd: "/repo" },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/helpers.ts" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: true, content: [{ type: "text", text: snapshotText }], details: { missingReadContext: { truncated: false } } } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/helpers.test.ts" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] } },
  ]));
  await writeFile(path.join(workspace, "empty.jsonl"), "");
  await writeFile(path.join(workspace, "session-without-reads.jsonl"), lines([
    { type: "session", cwd: "/repo" },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ]));

  const outFile = path.join(root, "evidence.json");
  try {
    return await run({ root, outFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the command counts every session file and labels from the recorded read", async () => {
  await withCorpus(async ({ root, outFile }) => {
    await execFile(process.execPath, ["--experimental-strip-types", script, root, outFile]);

    const evidence = JSON.parse(await readFile(outFile, "utf8"));
    assert.equal(evidence.sessionsScanned, 3, "empty and read-less sessions still count");
    assert.equal(evidence.summary.sessionsWithReads, 1);
    assert.equal(evidence.summary.selections, 1);
    assert.equal(evidence.summary.observedLabels, 1);
    assert.equal(evidence.summary.precision, 1);
    assert.equal(evidence.summary.insufficient, true, "one label is below the bar");

    const record = evidence.records[0];
    assert.equal(record.candidateCount, 2);
    assert.equal(record.outcome, "correct");
    assert.deepEqual(record.observed, { ordinal: 1 });
    assert.deepEqual(Object.keys(record).sort(), [
      "callId", "candidateCount", "features", "observed", "outcome", "prediction", "sessionId",
    ]);
    assert.equal(/^[0-9a-f]{32}$/.test(record.sessionId), true);
    assert.equal(/^[0-9a-f]{32}$/.test(record.callId), true);
  });
});

test("the evidence carries no paths, names, cwd, error text, or session keys", async () => {
  await withCorpus(async ({ root, outFile }) => {
    await execFile(process.execPath, ["--experimental-strip-types", script, root, outFile]);
    const text = await readFile(outFile, "utf8");

    for (const leak of ["helpers", "utils", "/repo", "ENOENT", "session-with-read", "ws-a", "file body"]) {
      assert.equal(text.includes(leak), false, `evidence leaked ${leak}`);
    }
  });
});

test("the same corpus yields byte-identical evidence from different working directories", async () => {
  await withCorpus(async ({ root, outFile }) => {
    const firstDir = await mkdtemp(path.join(tmpdir(), "welder-cwd-a-"));
    const secondDir = await mkdtemp(path.join(tmpdir(), "welder-cwd-b-"));
    const secondOut = path.join(root, "evidence-2.json");
    try {
      await execFile(process.execPath, ["--experimental-strip-types", script, root, outFile], { cwd: firstDir });
      await execFile(process.execPath, ["--experimental-strip-types", script, root, secondOut], { cwd: secondDir });

      const first = await readFile(outFile, "utf8");
      const second = await readFile(secondOut, "utf8");
      assert.equal(second, first, "session ids and output must not depend on the invocation cwd");
      assert.equal(JSON.parse(first).records[0].sessionId, JSON.parse(second).records[0].sessionId);
    } finally {
      await rm(firstDir, { recursive: true, force: true });
      await rm(secondDir, { recursive: true, force: true });
    }
  });
});
