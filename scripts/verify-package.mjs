/**
 * TASK-0041 — package verification.
 *
 * Packs exactly one artifact, proves its identity and contents against the
 * runtime import closure, installs it into an isolated consumer whose peers are
 * the pinned versions from the repository install, then loads it through the
 * real Pi host loader and a real `pi` process, offline.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

function sameSet(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const archiveDir = await mkdtemp(path.join(tmpdir(), "pi-welder-package-"));
const consumerDir = await mkdtemp(path.join(tmpdir(), "pi-welder-consumer-"));
try {
  const runtime = await runtimeClosure();
  if (runtime.length === 0) throw new Error("Runtime closure is empty");

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

  const archive = process.env.PACKAGE_TARBALL
    ? path.resolve(process.env.PACKAGE_TARBALL)
    : path.join(archiveDir, (JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", archiveDir], { cwd: root, env: environment })).stdout)[0].filename));
  if (!archive.endsWith(".tgz") || !existsSync(archive)) throw new Error(`npm pack did not produce an archive: ${archive}`);

  // Isolated consumer: pinned peers linked from the repository install, so the
  // whole check runs offline and cannot drift from the versions Pi ships.
  const consumerManifest = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8"));
  await writeFile(path.join(consumerDir, "package.json"), JSON.stringify({ ...consumerManifest, private: true }, null, 2));
  for (const peer of Object.keys(consumerManifest.dependencies)) {
    const target = path.join(consumerDir, "node_modules", ...peer.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(root, "node_modules", ...peer.split("/")), target, "dir");
  }

  // The tarball is extracted outside node_modules and linked into it. Node
  // refuses to type-strip TS inside node_modules, while the real install layout
  // resolves through the symlink to the same files.
  // Peers must be the pinned versions, linked into the isolated consumer.
  for (const [peer, pinned] of Object.entries(consumerManifest.dependencies)) {
    const installedPeer = JSON.parse(await readFile(path.join(root, "node_modules", ...peer.split("/"), "package.json"), "utf8"));
    if (installedPeer.version !== pinned)
      throw new Error(`Repository ${peer} is ${installedPeer.version}, the pinned consumer contract requires ${pinned}`);
  }

  const packageRoot = path.join(consumerDir, "pkg");
  await mkdir(packageRoot, { recursive: true });
  await execFile("tar", ["-xzf", archive, "-C", packageRoot, "--strip-components=1"]);
  const linkedRoot = path.join(consumerDir, "node_modules", "@carbon-ni", "pi-welder");
  await mkdir(path.dirname(linkedRoot), { recursive: true });
  await symlink(path.relative(path.dirname(linkedRoot), packageRoot), linkedRoot, "dir");

  const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (installed.name !== manifest.name || installed.version !== manifest.version)
    throw new Error(`Installed package identity mismatch: ${installed.name}@${installed.version}`);
  if (installed.license !== "MIT") throw new Error(`Installed license must be MIT, found ${installed.license}`);
  if (installed.publishConfig?.access !== "public") throw new Error("Scoped package is not configured for public access");
  if (JSON.stringify(installed.pi?.extensions) !== JSON.stringify(["./src/index.ts"]))
    throw new Error("Installed pi extensions manifest is not the source entrypoint");
  for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    if (installed.peerDependencies?.[peer] !== "*") throw new Error(`Peer ${peer} must be declared with the "*" range`);
    if (installed.dependencies?.[peer] !== undefined) throw new Error(`Peer ${peer} must not be a runtime dependency`);
  }
  if (installed.dependencies !== undefined && Object.keys(installed.dependencies).length > 0)
    throw new Error(`Host-provided packages must not be bundled: ${Object.keys(installed.dependencies).join(", ")}`);

  // `package.json` is always packed and never listed in `files`.
  const declaredFiles = [...runtime, ...REQUIRED_ROOT_FILES.filter((file) => file !== "package.json")];
  const packedFiles = installed.files ?? [];
  if (!sameSet(packedFiles, declaredFiles))
    throw new Error(`Installed manifest files do not match the runtime closure (${packedFiles.length} declared, ${declaredFiles.length} expected)`);
  if (packedFiles.some((file) => /\.test\.ts$|^plans\/|^scripts\/|^\.tmp\/|^\.pi\//.test(file)))
    throw new Error("Development files leaked into the installed manifest");

  // The packed extension loads from the consumer root and resolves peers from it.
  const extensionEntry = path.join(packageRoot, "src", "index.ts");
  const loaded = await execFile(
    process.execPath,
    [
      "--experimental-strip-types", "--input-type=module", "-e",
      `const loaded = await import(${JSON.stringify(`file://${extensionEntry}`)});` +
        `if (typeof loaded.default !== "function") throw new Error("extension entrypoint missing");` +
        `const value = await import(${JSON.stringify("typebox/value")});` +
        `if (typeof value.Value?.Check !== "function") throw new Error("peer typebox/value is not resolvable");` +
        `const host = await import("@earendil-works/pi-coding-agent");` +
        `if (typeof host.createAgentSession !== "function") throw new Error("host peer is not importable from the consumer");`,
    ],
    { cwd: consumerDir, env: environment },
  );
  if (loaded.stderr) process.stderr.write(loaded.stderr);

  // Real Pi host loader, offline: the same loader the CLI uses.
  const hostLoad = await execFile(
    process.execPath,
    [
      "--experimental-strip-types", "--input-type=module", "-e",
      `const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");` +
        `const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(),` +
        ` extensionFactories: [], additionalExtensionPaths: [${JSON.stringify(extensionEntry)}],` +
        ` noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });` +
        `await loader.reload();` +
        `const result = loader.getExtensions();` +
        `if (result.errors.length > 0) throw new Error("host load errors: " + JSON.stringify(result.errors));` +
        `const names = result.extensions.map((extension) => extension.path);` +
        `if (!names.some((name) => name.includes("pi-welder"))) throw new Error("packed extension not loaded: " + JSON.stringify(names));`,
    ],
    { cwd: consumerDir, env: { ...environment, PI_OFFLINE: "1" } },
  );
  if (hostLoad.stderr) process.stderr.write(hostLoad.stderr);

  // A real `pi` process must also start with the packed extension, offline.
  const piBin = process.env.PI_BIN ?? "pi";
  const installedEntry = path.join(linkedRoot, "src", "index.ts");
  const cli = await execFile(piBin, ["--no-extensions", "--extension", installedEntry, "--help"], {
    cwd: consumerDir,
    env: { ...environment, PI_OFFLINE: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const cliOutput = `${cli.stdout}${cli.stderr}`;
  if (!cliOutput.includes("--extension")) throw new Error("pi did not render help output");
  if (/Failed to load extension|Unknown extension|Cannot find module/i.test(cliOutput))
    throw new Error(`pi host extension load failed: ${cliOutput}`);

  console.log(`Package verification passed: ${manifest.name}@${manifest.version} (${packed.length} files) from ${archive}`);
} finally {
  await rm(archiveDir, { recursive: true, force: true });
  await rm(consumerDir, { recursive: true, force: true });
}
