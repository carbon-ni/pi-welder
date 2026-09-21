/**
 * TASK-0041 — package verification.
 *
 * Packs exactly one artifact, proves its identity and contents against the
 * runtime import closure, installs it into a real isolated consumer
 * (`npm ci` for the pinned peers, then `npm install` of the canonical tarball),
 * and proves the installed extension loads inside the real Pi host offline.
 *
 * The consumer install needs network or an npm cache: the pinned peers are
 * fetched by npm exactly as a user installs them. Nothing links back to this
 * repository, and NODE_PATH stays empty.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "package-fixtures", "release-consumer");
const environment = { ...process.env, NODE_PATH: "" };
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/** Root files every tarball must carry. */
const REQUIRED_ROOT_FILES = ["package.json", "README.md", "LICENSE"];
/** Packages Pi provides at runtime. */
const HOST_PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

/** Files reachable from the extension entrypoint: the runtime closure. */
export async function runtimeClosure(entry = path.join(root, "src/index.ts")) {
  const seen = new Set();
  const resolve = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    return [base, `${base}.ts`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
  };
  const walk = async (file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const resolved = resolve(file, match[1]);
      if (resolved) await walk(resolved);
    }
  };
  await walk(entry);
  return [...seen].filter((file) => !file.endsWith(".test.ts")).sort();
}

/** Bare import specifiers used by the packed runtime, as package names. */
export async function externalImports(files) {
  const names = new Set();
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(/from\s+"([^."][^"]*)"/g)) {
      if (match[1].startsWith("node:")) continue;
      const parts = match[1].split("/");
      names.add(match[1].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  return [...names].sort();
}

function sameSet(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

const archiveDir = await mkdtemp(path.join(tmpdir(), "pi-welder-package-"));
const consumerDir = await mkdtemp(path.join(tmpdir(), "pi-welder-consumer-"));
try {
  const runtime = await runtimeClosure();
  if (runtime.length === 0) throw new Error("Runtime closure is empty");

  // Contents: the packed set must be exactly the runtime closure plus root files.
  const dryRun = await execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root, env: environment });
  const dryManifest = JSON.parse(dryRun.stdout)[0];
  if (dryManifest.name !== manifest.name || dryManifest.version !== manifest.version)
    throw new Error(`Package identity mismatch: ${dryManifest.name}@${dryManifest.version}`);
  const packed = dryManifest.files.map((entry) => entry.path).sort();
  const expected = [...runtime, ...REQUIRED_ROOT_FILES].sort();
  const missing = expected.filter((file) => !packed.includes(file));
  if (missing.length > 0) throw new Error(`Required packed file missing: ${missing.join(", ")}`);
  const unexpected = packed.filter((file) => !expected.includes(file));
  if (unexpected.length > 0)
    throw new Error(`Unexpected packed file (tests, plans, scripts, or artifacts?): ${unexpected.join(", ")}`);

  // The packed runtime may import only host-provided peers.
  for (const name of await externalImports(runtime)) {
    if (!HOST_PEERS.includes(name)) throw new Error(`Packed runtime imports a non-peer package: ${name}`);
  }
  if (JSON.stringify(Object.keys(manifest.peerDependencies ?? {}).sort()) !== JSON.stringify([...HOST_PEERS].sort()))
    throw new Error("peerDependencies must be exactly the host-provided packages");
  if (Object.keys(manifest.dependencies ?? {}).length > 0)
    throw new Error("Runtime dependencies must stay empty; Pi provides the host packages");

  const archive = process.env.PACKAGE_TARBALL
    ? path.resolve(process.env.PACKAGE_TARBALL)
    : path.join(archiveDir, JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", archiveDir], { cwd: root, env: environment })).stdout)[0].filename);
  if (!archive.endsWith(".tgz") || !existsSync(archive)) throw new Error(`npm pack did not produce an archive: ${archive}`);

  // Isolated consumer: the committed fixture, installed by npm, no repository links.
  const fixtureManifest = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8"));
  await writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  const fixtureLock = await readFile(path.join(fixture, "package-lock.json"), "utf8");
  await writeFile(path.join(consumerDir, "package-lock.json"), fixtureLock);

  console.log("Installing the committed pinned consumer fixture (network or npm cache required)...");
  await execFile("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerDir, env: environment });

  const requested = JSON.parse(await readFile(path.join(consumerDir, "package-lock.json"), "utf8"));
  if (requested.name !== fixtureManifest.name) throw new Error("The fixture lock does not match the fixture manifest");

  await execFile("npm", ["install", archive, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"], { cwd: consumerDir, env: environment });
  if ((await readFile(path.join(consumerDir, "package-lock.json"), "utf8")) !== fixtureLock)
    throw new Error("Installing the tarball mutated the committed consumer lock");

  const linkRoot = path.join(consumerDir, "node_modules", "@carbon-ni", "pi-welder");
  if (!existsSync(linkRoot)) throw new Error("The tarball was not installed into the consumer");
  if ((await lstat(linkRoot)).isSymbolicLink()) throw new Error("The installed package must not be a symlink");
  const installed = JSON.parse(await readFile(path.join(linkRoot, "package.json"), "utf8"));

  // Pinned peers really are installed under the consumer, at the pinned versions.
  for (const [peer, pinned] of Object.entries(fixtureManifest.dependencies)) {
    const peerManifest = path.join(consumerDir, "node_modules", ...peer.split("/"), "package.json");
    if (!existsSync(peerManifest)) throw new Error(`Pinned peer is not installed in the consumer: ${peer}`);
    const version = JSON.parse(await readFile(peerManifest, "utf8")).version;
    if (version !== pinned) throw new Error(`Consumer ${peer} is ${version}, expected the pin ${pinned}`);
  }

  // The installed manifest still describes what the docs claim.
  if (installed.name !== manifest.name || installed.version !== manifest.version)
    throw new Error(`Installed package identity mismatch: ${installed.name}@${installed.version}`);
  if (installed.license !== "MIT") throw new Error(`Installed license must be MIT, found ${installed.license}`);
  if (installed.publishConfig?.access !== "public") throw new Error("Scoped package is not configured for public access");
  if (JSON.stringify(installed.pi?.extensions) !== JSON.stringify(["./src/index.ts"]))
    throw new Error("Installed pi extensions manifest is not the source entrypoint");
  for (const peer of HOST_PEERS) {
    if (installed.peerDependencies?.[peer] !== "*") throw new Error(`Peer ${peer} must be declared with the "*" range`);
    if (installed.dependencies?.[peer] !== undefined) throw new Error(`Peer ${peer} must not be a runtime dependency`);
  }
  if (Object.keys(installed.dependencies ?? {}).length > 0)
    throw new Error(`Host-provided packages must not be bundled: ${Object.keys(installed.dependencies).join(", ")}`);

  // `package.json` is always packed and never listed in `files`.
  const declaredFiles = [...runtime, ...REQUIRED_ROOT_FILES.filter((file) => file !== "package.json")];
  const packedFiles = installed.files ?? [];
  if (!sameSet(packedFiles, declaredFiles))
    throw new Error(`Installed manifest files do not match the runtime closure (${packedFiles.length} declared, ${declaredFiles.length} expected)`);
  if (packedFiles.some((file) => /\.test\.ts$|^plans\/|^scripts\/|^\.tmp\/|^\.pi\//.test(file)))
    throw new Error("Development files leaked into the installed manifest");

  // Peers resolve from the consumer root, not from this repository.
  const peerProbe = await execFile(
    process.execPath,
    [
      "--input-type=module", "-e",
      `const value = await import("typebox/value");` +
        `if (typeof value.Value?.Check !== "function") throw new Error("peer typebox/value is not resolvable");` +
        `const host = await import("@earendil-works/pi-coding-agent");` +
        `if (typeof host.createAgentSession !== "function") throw new Error("host peer is not importable");`,
    ],
    { cwd: consumerDir, env: environment },
  );
  if (peerProbe.stderr) process.stderr.write(peerProbe.stderr);

  // The installed extension loads inside the real Pi host, offline. A control
  // extension proves the mechanism and reports the packed module's own load, so
  // this cannot pass while the artifact is unloadable.
  const entry = path.join(linkRoot, "src", "index.ts");
  const control = path.join(consumerDir, "host-control.ts");
  await writeFile(
    control,
    `const target = ${JSON.stringify(`file://${entry}`)};\n` +
      `export default async function () {\n` +
      `  try {\n` +
      `    const loaded = await import(target);\n` +
      `    console.log("PI_WELDER_PACKED_LOADED:" + typeof loaded.default);\n` +
      `  } catch (error) {\n` +
      `    console.log("PI_WELDER_PACKED_FAILED:" + (error?.message ?? error));\n` +
      `  }\n` +
      `}\n`,
  );

  const piBin = process.env.PI_BIN ?? "pi";
  const host = await execFile(piBin, ["--no-extensions", "--extension", control, "--extension", entry, "--help"], {
    cwd: consumerDir,
    env: { ...environment, PI_OFFLINE: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const hostOutput = `${host.stdout}${host.stderr}`;
  if (hostOutput.includes("PI_WELDER_PACKED_FAILED"))
    throw new Error(`The packed extension failed to load inside the Pi host: ${hostOutput}`);
  if (!hostOutput.includes("PI_WELDER_PACKED_LOADED:function"))
    throw new Error(`The packed extension did not load inside the Pi host: ${hostOutput}`);

  console.log(`Package verification passed: ${manifest.name}@${manifest.version} (${packed.length} files, sha256 ${await sha256(archive)})`);
} finally {
  await rm(archiveDir, { recursive: true, force: true });
  await rm(consumerDir, { recursive: true, force: true });
}
