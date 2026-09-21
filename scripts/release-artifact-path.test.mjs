/**
 * TASK-0042 QA — behavioral tests for single-artifact selection.
 *
 * The script runs as a child process, so the workflow's actual command is
 * exercised: a clean directory, zero or one tarball, and a directory holding a
 * stale artifact plus a fresh one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { singleTarball } from "./release-artifact-path.mjs";

const execFile = promisify(execFileCallback);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "release-artifact-path.mjs");

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "welder-artifact-"));
  return run(directory).finally(() => rm(directory, { recursive: true, force: true }));
}

test("exactly one tarball is selected; zero or many are refused", () => {
  assert.equal(singleTarball(["a-1.0.0.tgz"], "/r"), path.join("/r", "a-1.0.0.tgz"));
  assert.throws(() => singleTarball([], "/r"), /No release artifact/);
  assert.throws(() => singleTarball(["notes.txt"], "/r"), /No release artifact/);
  assert.throws(() => singleTarball(["a.tgz", "b.tgz"], "/r"), /Expected exactly one release artifact in \/r, found 2: a\.tgz, b\.tgz/);
});

test("the script prints the one tarball of the directory", async () => {
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, "carbon-ni-pi-welder-0.0.1.tgz"), "bytes");
    await writeFile(path.join(directory, "SHA256SUMS"), "ignored\n");

    const run = await execFile(process.execPath, [script, directory]);
    assert.equal(run.stdout.trim(), path.join(directory, "carbon-ni-pi-welder-0.0.1.tgz"));
  });
});

test("a stale artifact cannot be selected silently", async () => {
  await withDirectory(async (directory) => {
    // A reused runner that kept an old tarball must fail loudly instead of
    // uploading one of two artifacts.
    await writeFile(path.join(directory, "carbon-ni-pi-welder-0.0.0.tgz"), "stale");
    await writeFile(path.join(directory, "carbon-ni-pi-welder-0.0.1.tgz"), "fresh");

    await assert.rejects(
      () => execFile(process.execPath, [script, directory]),
      (error) => /Expected exactly one release artifact in .*found 2/.test(String(error.stderr)),
    );
  });
});

test("a missing directory and a missing argument fail clearly", async () => {
  await assert.rejects(
    () => execFile(process.execPath, [script, path.join(tmpdir(), "welder-absent-dir")]),
    (error) => /Cannot read artifact directory/.test(String(error.stderr)),
  );
  await assert.rejects(
    () => execFile(process.execPath, [script]),
    (error) => /Usage:/.test(String(error.stderr)),
  );
});
