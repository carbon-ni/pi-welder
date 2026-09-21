/**
 * TASK-0042 QA — resolve the single release artifact.
 *
 * The quality gate must pack exactly one tarball and every later step must use
 * that one. Picking the "first" tarball silently tolerates a stale file on a
 * reused runner, so this refuses anything but exactly one match.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Pure selection: throws unless the directory holds exactly one `.tgz`. */
export function singleTarball(entries, directory) {
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz")).sort();
  if (tarballs.length === 0) throw new Error(`No release artifact (.tgz) in ${directory}`);
  if (tarballs.length > 1)
    throw new Error(`Expected exactly one release artifact in ${directory}, found ${tarballs.length}: ${tarballs.join(", ")}`);
  return path.join(directory, tarballs[0]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/release-artifact-path.mjs <directory>");
  const entries = await readdir(directory).catch(() => undefined);
  if (entries === undefined) throw new Error(`Cannot read artifact directory: ${directory}`);
  console.log(singleTarball(entries, directory));
}
