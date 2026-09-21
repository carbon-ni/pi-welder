/**
 * TASK-0041 — publish or resume one canonical release artifact.
 *
 * The artifact is packed and verified by the quality gate and travels to this
 * job by checksum. Publication is idempotent by byte identity: an existing
 * destination with the same SHA-256 is skipped, a different one fails loudly.
 * npm publishing uses trusted publishing (OIDC) with provenance, so no token is
 * read here.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Pure duplicate policy: identical bytes are resumable; mismatches are fatal. */
export function publicationDecision(localSha256, existingSha256) {
  if (!existingSha256) return "publish";
  if (existingSha256 === localSha256) return "identical";
  return "mismatch";
}

/** Stable releases use `latest`; prereleases use `next`. */
export function releaseNpmTag(prerelease) {
  return prerelease === true || prerelease === "true" ? "next" : "latest";
}

export function releaseTagMatchesVersion(tag, version) {
  return tag === `v${version}`;
}

export function qualityGateAllowsPublish(result) {
  return result === "success";
}

const MISSING_NPM_CODES = new Set(["E404", "ETARGET"]);

/** A missing registry artifact resumes; any other failure is fatal. */
export function isMissingNpmArtifactError(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.error?.code !== undefined) return MISSING_NPM_CODES.has(parsed.error.code);
    } catch {
      return false;
    }
  }
  const errorCode = typeof error?.code === "string" ? error.code.toUpperCase() : undefined;
  if (errorCode?.startsWith("E")) return MISSING_NPM_CODES.has(errorCode);
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  return MISSING_NPM_CODES.has(stderr.match(/(?:^|\n)\s*npm\s+(?:error|ERR!)\s+code\s+(E404|ETARGET)\b/im)?.[1]?.toUpperCase());
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function npmArtifact(packageName, version, directory, run) {
  try {
    const result = await run("npm", ["pack", `${packageName}@${version}`, "--ignore-scripts", "--json", "--pack-destination", directory]);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Malformed npm pack response for ${packageName}@${version}`);
    }
    if (!Array.isArray(parsed) || typeof parsed[0]?.filename !== "string")
      throw new Error(`Malformed npm pack response for ${packageName}@${version}`);
    const filename = parsed[0].filename;
    return path.isAbsolute(filename) ? filename : path.join(directory, filename);
  } catch (error) {
    if (isMissingNpmArtifactError(error)) return null;
    // A malformed body already carries the documented message.
    throw error;
  }
}

async function existingReleaseAsset(tag, filename, directory, run) {
  const view = await run("gh", ["release", "view", tag, "--json", "assets"]);
  let assets;
  try {
    assets = JSON.parse(view.stdout).assets;
  } catch {
    throw new Error(`Malformed gh release response for ${tag}`);
  }
  if (!Array.isArray(assets)) throw new Error(`Malformed gh release response for ${tag}`);
  if (!assets.some((asset) => asset?.name === filename)) return null;
  await run("gh", ["release", "download", tag, "--pattern", filename, "--dir", directory]);
  return path.join(directory, filename);
}

export async function publishRelease({ tarball, packageName, version, releaseTag, npmTag, gateResult = "success", run = execFile }) {
  if (!qualityGateAllowsPublish(gateResult)) throw new Error("Quality gate did not authorize publication");
  if (!releaseTagMatchesVersion(releaseTag, version))
    throw new Error(`Release tag ${releaseTag} does not match package version ${version}`);

  const localSha256 = await sha256(tarball);
  const work = await mkdtemp(path.join(tmpdir(), "pi-welder-release-"));
  const npmWork = await mkdtemp(path.join(work, "npm-"));
  const githubWork = await mkdtemp(path.join(work, "github-"));
  try {
    const npmExisting = await npmArtifact(packageName, version, npmWork, run);
    const npmDecision = publicationDecision(localSha256, npmExisting && (await sha256(npmExisting)));
    if (npmDecision === "mismatch") throw new Error(`npm ${packageName}@${version} exists with different artifact bytes`);
    if (npmDecision === "publish") await run("npm", ["publish", tarball, "--access", "public", "--tag", npmTag]);

    const asset = path.basename(tarball);
    const releaseExisting = await existingReleaseAsset(releaseTag, asset, githubWork, run);
    const releaseDecision = publicationDecision(localSha256, releaseExisting && (await sha256(releaseExisting)));
    if (releaseDecision === "mismatch") throw new Error(`GitHub Release ${releaseTag} has a different ${asset}`);
    if (releaseDecision === "publish") await run("gh", ["release", "upload", releaseTag, tarball]);

    const checksum = path.join(path.dirname(tarball), "SHA256SUMS");
    const checksumExisting = await existingReleaseAsset(releaseTag, "SHA256SUMS", githubWork, run);
    if (checksumExisting) {
      const [expected, actual] = await Promise.all([readFile(checksum, "utf8"), readFile(checksumExisting, "utf8")]);
      if (expected !== actual) throw new Error(`GitHub Release ${releaseTag} has a different SHA256SUMS`);
    } else {
      await run("gh", ["release", "upload", releaseTag, checksum]);
    }
    return { npm: npmDecision, github: releaseDecision, sha256: localSha256 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tarball = process.argv[2];
  if (!tarball) throw new Error("Usage: node scripts/release-publish.mjs <tarball>");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const result = await publishRelease({
    tarball,
    packageName: manifest.name,
    version: manifest.version,
    releaseTag: process.env.RELEASE_TAG,
    npmTag: process.env.NPM_TAG ?? releaseNpmTag(process.env.RELEASE_PRERELEASE),
    gateResult: process.env.QUALITY_GATE_RESULT ?? "success",
  });
  console.log(JSON.stringify(result));
}
