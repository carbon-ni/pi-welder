/**
 * TASK-0042 — write the release checksum next to the artifact.
 *
 * The manifest must name the file exactly as a consumer sees it, so it holds the
 * bare filename even when the tarball sits in a directory. That is what the
 * publisher compares against, and what `actions/download-artifact` reproduces
 * when it flattens the artifact into one directory.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CHECKSUM_FILE = "SHA256SUMS";

/**
 * Returns the exact manifest content for a tarball: `<sha256>  <basename>`.
 * Pure, so the format has one definition.
 */
export function checksumLine(tarballPath, bytes) {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(tarballPath)}\n`;
}

/** Writes `${dir(tarball)}/SHA256SUMS` and returns the line it wrote. */
export async function writeChecksumFile(tarballPath, read = readFile, write = writeFile) {
  const bytes = await read(tarballPath).catch(() => undefined);
  if (bytes === undefined) throw new Error(`Cannot read tarball: ${tarballPath}`);
  const line = checksumLine(tarballPath, bytes);
  await write(path.join(path.dirname(tarballPath), CHECKSUM_FILE), line);
  return line;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tarball = process.argv[2];
  if (!tarball) throw new Error(`Usage: node scripts/release-checksum.mjs <tarball>`);
  if (!tarball.endsWith(".tgz")) throw new Error(`Release artifact must be a .tgz archive: ${tarball}`);
  const line = await writeChecksumFile(path.resolve(tarball));
  console.log(line.trimEnd());
}
