/**
 * TASK-0041 — behavioral tests for the release policy.
 *
 * The GitHub/npm boundary is a command runner, so every scenario drives the real
 * `publishRelease` with a recording fake and asserts the exact command sequence
 * and the decision it reports: new, resumed, mismatched, invalid tag, failed
 * gate, stable/prerelease, authentication, network, and malformed responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isMissingNpmArtifactError,
  verifyChecksumFile,
  publicationDecision,
  publishRelease,
  qualityGateAllowsPublish,
  releaseNpmTag,
  releaseTagMatchesVersion,
} from "./release-publish.mjs";

const VERSION = "0.0.1";
const PACKAGE = "@carbon-ni/pi-welder";
/** npm's tarball name for a scoped package. */
const assetName = () => `${PACKAGE.replace("@", "").replace("/", "-")}-${VERSION}.tgz`;

async function withTarball(bytes, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "welder-publish-test-"));
  const tarball = path.join(directory, `${PACKAGE.replace("/", "-").replace("@", "")}-${VERSION}.tgz`);
  await writeFile(tarball, bytes);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  // The release workflow always writes the checksum next to the tarball.
  const checksumText = `${checksum}  ${path.basename(tarball)}\n`;
  await writeFile(path.join(directory, "SHA256SUMS"), checksumText);
  try {
    return await run({ tarball, checksum, checksumText, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Mimics `gh release download`: writes the asset into the requested directory. */
function ghDownloadHandler(source) {
  return async (args) => {
    const directory = args[args.indexOf("--dir") + 1];
    const name = args[args.indexOf("--pattern") + 1];
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), typeof source === "string" ? source : (source[name] ?? ""));
    return { stdout: "" };
  };
}

/** Records every command; handlers decide what the boundary returns. */
function recorder(handlers = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push([command, ...args]);
    const handler = handlers[`${command} ${args.slice(0, 2).join(" ")}`] ?? handlers[`${command} ${args[0]}`];
    if (handler) return handler(args, options);
    // Default registry state: this version does not exist yet.
    if (command === "npm" && args[0] === "pack")
      throw Object.assign(new Error("not found"), { stdout: JSON.stringify({ error: { code: "E404" } }) });
    if (command === "gh" && args[1] === "view") return { stdout: JSON.stringify({ assets: [] }) };
    if (command === "gh" && args[1] === "download") return ghDownloadHandler("")(args);
    return { stdout: "" };
  };
  return { calls, run, has: (needle) => calls.some((call) => call.join(" ").includes(needle)) };
}

async function publish(handlers, overrides = {}) {
  return withTarball("canonical bytes", async ({ tarball, checksum }) => {
    const { calls, run } = recorder(handlers);
    const result = await publishRelease({
      tarball, packageName: PACKAGE, version: VERSION, releaseTag: `v${VERSION}`, npmTag: "latest",
      run, ...overrides,
    }).catch((error) => error);
    return { result, calls, checksum };
  });
}

test("a new artifact publishes to npm and attaches to the release", async () => {
  const { result, calls } = await publish({});

  assert.equal(result.npm, "publish");
  assert.equal(result.github, "publish");
  assert.equal(result.sha256.length, 64);
  assert.equal(calls.some((call) => call.join(" ").includes("npm publish")), true);
  assert.equal(calls.some((call) => call.join(" ").includes("--access public --tag latest")), true);
  assert.equal(calls.some((call) => call.join(" ").includes("gh release upload v0.0.1")), true);
  assert.equal(calls.filter((call) => call[0] === "npm" && call[1] === "publish").length, 1);
});

test("a rerun against byte-identical destinations skips both publications", async () => {
  const bytes = "canonical bytes";
  const { result, calls } = await withTarball(bytes, async ({ tarball, checksumText }) => {
    const { calls, run } = recorder({});
    const existing = await mkdtemp(path.join(tmpdir(), "welder-existing-"));
    await writeFile(path.join(existing, "existing.tgz"), bytes);
    const result = await publishRelease({
      tarball, packageName: PACKAGE, version: VERSION, releaseTag: `v${VERSION}`, npmTag: "latest",
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "npm" && args[0] === "pack") return { stdout: JSON.stringify([{ filename: path.join(existing, "existing.tgz") }]) };
        if (command === "gh" && args[1] === "view") return { stdout: JSON.stringify({ assets: [{ name: path.basename(tarball) }, { name: "SHA256SUMS" }] }) };
        if (command === "gh" && args[1] === "download")
          return ghDownloadHandler({ [path.basename(tarball)]: bytes, SHA256SUMS: checksumText })(args);
        return { stdout: "" };
      },
    });
    await rm(existing, { recursive: true, force: true });
    return { result, calls };
  });

  assert.equal(result.npm, "identical");
  assert.equal(result.github, "identical");
  assert.equal(calls.some((call) => call.join(" ").includes("npm publish")), false, "no second npm publish");
  assert.equal(calls.some((call) => call.join(" ").includes("gh release upload")), false, "no second upload");
});

test("a byte mismatch at either destination fails loudly", async () => {
  const npmMismatch = await publish({
    "npm pack": async (args) => {
      const directory = args[args.indexOf("--pack-destination") + 1];
      await writeFile(path.join(directory, "existing.tgz"), "different bytes");
      return { stdout: JSON.stringify([{ filename: "existing.tgz" }]) };
    },
  });
  assert.match(String(npmMismatch.result), /different artifact bytes/);

  const releaseMismatch = await publish({
    "gh release view": () => ({ stdout: JSON.stringify({ assets: [{ name: assetName() }] }) }),
    "gh release download": ghDownloadHandler("different bytes"),
  });
  assert.match(String(releaseMismatch.result), /different/);
});

test("an invalid tag or a failed gate never touches a remote", async () => {
  const invalidTag = await publish({}, { releaseTag: "v9.9.9" });
  assert.match(String(invalidTag.result), /does not match package version/);
  assert.equal(invalidTag.calls.length, 0, "no remote command ran");

  const failedGate = await publish({}, { gateResult: "failure" });
  assert.match(String(failedGate.result), /did not authorize publication/);
  assert.equal(failedGate.calls.length, 0);
});

test("stable publishes to latest and prerelease to next", async () => {
  assert.equal(releaseNpmTag(false), "latest");
  assert.equal(releaseNpmTag("false"), "latest");
  assert.equal(releaseNpmTag(true), "next");
  assert.equal(releaseNpmTag("true"), "next");

  const prerelease = await publish({}, { npmTag: releaseNpmTag(true) });
  assert.equal(prerelease.calls.some((call) => call.join(" ").includes("--tag next")), true);
});

test("authentication and network failures abort instead of claiming success", async () => {
  const authentication = await publish({
    "npm publish": () => { throw Object.assign(new Error("auth"), { stdout: JSON.stringify({ error: { code: "E401" } }) }); },
  });
  assert.match(String(authentication.result), /auth/);
  assert.equal(authentication.calls.some((call) => call.join(" ").includes("gh release upload")), false, "no partial upload after npm fails");

  const network = await publish({ "npm pack": () => { throw new Error("ENOTFOUND registry.npmjs.org"); } });
  assert.match(String(network.result), /registry/);
});

test("malformed registry and release responses are rejected", async () => {
  const malformedPack = await publish({ "npm pack": () => ({ stdout: "not json" }) });
  assert.match(String(malformedPack.result), /Malformed npm pack response/);

  const malformedRelease = await publish({ "gh release view": () => ({ stdout: "not json" }) });
  assert.match(String(malformedRelease.result), /Malformed gh release response/);
});

test("only a genuinely missing artifact resumes; other npm errors do not", () => {
  assert.equal(isMissingNpmArtifactError({ stdout: JSON.stringify({ error: { code: "E404" } }) }), true);
  assert.equal(isMissingNpmArtifactError({ stdout: JSON.stringify({ error: { code: "ETARGET" } }) }), true);
  assert.equal(isMissingNpmArtifactError({ stdout: JSON.stringify({ error: { code: "E401" } }) }), false);
  assert.equal(isMissingNpmArtifactError({ code: "E404" }), true);
  assert.equal(isMissingNpmArtifactError({ stderr: "npm error code E404" }), true);
  assert.equal(isMissingNpmArtifactError({ stderr: "npm error code E500" }), false);
  assert.equal(isMissingNpmArtifactError(undefined), false);

  assert.equal(qualityGateAllowsPublish("success"), true);
  assert.equal(qualityGateAllowsPublish("failure"), false);
  assert.equal(publicationDecision("a", undefined), "publish");
  assert.equal(publicationDecision("a", "a"), "identical");
  assert.equal(publicationDecision("a", "b"), "mismatch");
  assert.equal(releaseTagMatchesVersion("v1.0.0", "1.0.0"), true);
  assert.equal(releaseTagMatchesVersion("1.0.0", "1.0.0"), false);
});

test("the local checksum manifest is validated before any remote call", async () => {
  const valid = { checksumText: `${"a".repeat(64)}  carbon-ni-pi-welder-0.0.1.tgz\n`, tarballName: "carbon-ni-pi-welder-0.0.1.tgz", actualSha256: "a".repeat(64) };
  assert.equal(verifyChecksumFile(valid).ok, true);
  assert.equal(verifyChecksumFile({ ...valid, checksumText: `${"a".repeat(64)}  *carbon-ni-pi-welder-0.0.1.tgz\n` }).ok, true, "binary marker is accepted");

  const malformed = [
    [undefined, /missing or unreadable/],
    ["", /empty/],
    ["not a checksum line", /malformed/],
    [`${"a".repeat(63)}  carbon-ni-pi-welder-0.0.1.tgz`, /malformed/],
    [`${"a".repeat(64)}`, /malformed/],
    [`${"a".repeat(64)}  other.tgz`, /exactly once/],
    [`${"a".repeat(64)}  carbon-ni-pi-welder-0.0.1.tgz\n${"a".repeat(64)}  carbon-ni-pi-welder-0.0.1.tgz`, /exactly once/],
  ];
  for (const [checksumText, pattern] of malformed) {
    const result = verifyChecksumFile({ checksumText, ...valid, checksumText });
    assert.equal(result.ok, false, String(checksumText));
    assert.match(result.reason, pattern);
  }

  const mismatch = verifyChecksumFile({ ...valid, actualSha256: "b".repeat(64) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /declares a+ for carbon-ni-pi-welder-0\.0\.1\.tgz, the artifact is b+/);
});

test("a mismatched or malformed local manifest stops the run before npm or gh", async () => {
  const { result, calls } = await withTarball("canonical bytes", async ({ tarball, directory }) => {
    await writeFile(path.join(directory, "SHA256SUMS"), `${"b".repeat(64)}  ${path.basename(tarball)}\n`);
    const { calls, run } = recorder({});
    const result = await publishRelease({ tarball, packageName: PACKAGE, version: VERSION, releaseTag: `v${VERSION}`, npmTag: "latest", run })
      .catch((error) => error);
    return { result, calls };
  });
  assert.match(String(result), /Local artifact verification failed/);
  assert.equal(calls.length, 0, "no remote command ran on a checksum mismatch");

  const malformed = await withTarball("canonical bytes", async ({ tarball, directory }) => {
    await writeFile(path.join(directory, "SHA256SUMS"), "garbage\n");
    const { calls, run } = recorder({});
    const result = await publishRelease({ tarball, packageName: PACKAGE, version: VERSION, releaseTag: `v${VERSION}`, npmTag: "latest", run })
      .catch((error) => error);
    return { result, calls };
  });
  assert.match(String(malformed.result), /malformed SHA256SUMS entry/);
  assert.equal(malformed.calls.length, 0);

  const missing = await withTarball("canonical bytes", async ({ tarball, directory }) => {
    await rm(path.join(directory, "SHA256SUMS"), { force: true });
    const { calls, run } = recorder({});
    const result = await publishRelease({ tarball, packageName: PACKAGE, version: VERSION, releaseTag: `v${VERSION}`, npmTag: "latest", run })
      .catch((error) => error);
    return { result, calls };
  });
  assert.match(String(missing.result), /missing or unreadable/);
  assert.equal(missing.calls.length, 0);
});
