/**
 * TASK-0042 — behavioral tests for checksum generation.
 *
 * These execute the real script (as a child process, from a different working
 * directory, with the tarball in a nested directory) and feed its output to the
 * real publisher validator, so the workflow's dry flow and the published layout
 * cannot drift from what the publisher accepts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CHECKSUM_FILE, checksumLine, writeChecksumFile } from "./release-checksum.mjs";
import { verifyChecksumFile } from "./release-publish.mjs";

const execFile = promisify(execFileCallback);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "release-checksum.mjs");
const TARBALL = "carbon-ni-pi-welder-0.0.1.tgz";

async function withArtifact(run) {
  const workspace = await mkdtemp(path.join(tmpdir(), "welder-checksum-"));
  const releaseDir = path.join(workspace, ".release");
  const tarball = path.join(releaseDir, TARBALL);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(tarball, "canonical tarball bytes");
  return run({ workspace, releaseDir, tarball }).finally(() => rm(workspace, { recursive: true, force: true }));
}

test("the manifest holds the bare filename even when the tarball is nested", () => {
  const line = checksumLine(`/tmp/.release/${TARBALL}`, Buffer.from("bytes"));
  assert.equal(line, `${createHash("sha256").update("bytes").digest("hex")}  ${TARBALL}\n`);
  assert.equal(line.includes(".release/"), false, "no directory in the manifest");
  assert.equal(line.includes("/"), false);
});

test("the script writes the manifest next to the artifact, from any working directory", async () => {
  await withArtifact(async ({ workspace, releaseDir, tarball }) => {
    // Run from a different directory, exactly as the workflow does.
    const other = path.join(workspace, "elsewhere");
    await mkdir(other, { recursive: true });
    const run = await execFile(process.execPath, [script, tarball], { cwd: other });

    const manifest = await readFile(path.join(releaseDir, CHECKSUM_FILE), "utf8");
    assert.equal(run.stdout.trimEnd(), manifest.trimEnd(), "stdout reports the manifest line");
    assert.equal(manifest, checksumLine(tarball, Buffer.from("canonical tarball bytes")));

    // The publisher's validator accepts it and the digest matches the bytes.
    const verification = verifyChecksumFile({
      checksumText: manifest,
      tarballName: path.basename(tarball),
      actualSha256: createHash("sha256").update("canonical tarball bytes").digest("hex"),
    });
    assert.equal(verification.ok, true, verification.reason);
  });
});

test("the downloaded-artifact layout verifies too", async () => {
  await withArtifact(async ({ workspace, releaseDir, tarball }) => {
    await execFile(process.execPath, [script, tarball]);

    // `actions/download-artifact` flattens the artifact into one directory.
    const downloadDir = path.join(workspace, "downloaded");
    await mkdir(downloadDir, { recursive: true });
    const downloadedTarball = path.join(downloadDir, path.basename(tarball));
    await writeFile(downloadedTarball, await readFile(tarball));
    await writeFile(path.join(downloadDir, CHECKSUM_FILE), await readFile(path.join(releaseDir, CHECKSUM_FILE)));

    const verification = verifyChecksumFile({
      checksumText: await readFile(path.join(downloadDir, CHECKSUM_FILE), "utf8"),
      tarballName: path.basename(downloadedTarball),
      actualSha256: createHash("sha256").update(await readFile(downloadedTarball)).digest("hex"),
    });
    assert.equal(verification.ok, true, verification.reason);
  });
});

test("the script refuses non-archives and missing files without writing a manifest", async () => {
  await withArtifact(async ({ releaseDir, tarball }) => {
    const notAnArchive = path.join(releaseDir, "notes.txt");
    await writeFile(notAnArchive, "x");
    await assert.rejects(() => execFile(process.execPath, [script, notAnArchive]), /must be a \.tgz archive/);

    await assert.rejects(() => execFile(process.execPath, [script, path.join(releaseDir, "missing.tgz")]), /Cannot read tarball/);
    await assert.rejects(() => execFile(process.execPath, [script]), /Usage:/);

    // Only the successful run may leave a manifest behind.
    await rm(path.join(releaseDir, CHECKSUM_FILE), { force: true });
    await execFile(process.execPath, [script, tarball]);
    const written = await readFile(path.join(releaseDir, CHECKSUM_FILE), "utf8");
    assert.equal(written.endsWith(`  ${TARBALL}\n`), true, written);
  });
});

test("writeChecksumFile propagates an unreadable artifact", async () => {
  await assert.rejects(
    () => writeChecksumFile("/tmp/absent.tgz", async () => { throw new Error("ENOENT"); }),
    /Cannot read tarball/,
  );
});
