/**
 * TASK-0022 — deterministic missing-read candidate generation.
 *
 * Bounded and deterministic: at most 5 readable regular files under the real
 * session cwd, ranked by basename/path similarity with stable tie-breaking.
 * Symlink/path escape, unreadable roots, directory reads, and files outside
 * cwd fail closed. Only RELATIVE paths are ever produced; no file contents.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { FileSystem } from "../infra/filesystem.ts";
import { nodeFileSystem } from "../infra/filesystem.ts";

export const MAX_PATH_CANDIDATES = 5;
export const MAX_SCAN_ENTRIES = 2_000;

export interface CandidatePath {
  ordinal: number;
  /** Path relative to cwd, using forward slashes. Never absolute. */
  path: string;
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function basenameOf(relativePath: string): string {
  const normalized = toPosix(relativePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function directoryOf(relativePath: string): string {
  const normalized = toPosix(relativePath);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function sharedDirectorySegments(left: string, right: string): number {
  const leftSegments = directoryOf(left).split("/").filter(Boolean);
  const rightSegments = directoryOf(right).split("/").filter(Boolean);
  let shared = 0;
  while (shared < leftSegments.length && shared < rightSegments.length && leftSegments[shared] === rightSegments[shared]) shared++;
  return shared;
}

/**
 * Deterministic ranking. Order:
 * 1. identical basename, 2. longer common basename prefix, 3. smaller basename
 * length delta, 4. more shared directory segments, 5. lexicographic path.
 */
export function rankPathCandidates(requestedPath: string, paths: readonly string[]): string[] {
  const requestedBase = basenameOf(requestedPath);
  return [...new Set(paths.map(toPosix))].sort((a, b) => {
    const aBase = basenameOf(a);
    const bBase = basenameOf(b);
    const sameBase = Number(bBase === requestedBase) - Number(aBase === requestedBase);
    if (sameBase !== 0) return sameBase;

    const prefix = commonPrefixLength(bBase, requestedBase) - commonPrefixLength(aBase, requestedBase);
    if (prefix !== 0) return prefix;

    const lengthDelta = Math.abs(aBase.length - requestedBase.length) - Math.abs(bBase.length - requestedBase.length);
    if (lengthDelta !== 0) return lengthDelta;

    const shared = sharedDirectorySegments(b, requestedPath) - sharedDirectorySegments(a, requestedPath);
    if (shared !== 0) return shared;

    return a.localeCompare(b);
  });
}

/** A requested path is eligible only when it is a relative, contained path. */
function requestedRelativePath(requestedPath: string): string | undefined {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) return undefined;
  if (requestedPath.includes("\u0000") || requestedPath.includes("\n")) return undefined;
  if (isAbsolute(requestedPath)) return undefined;
  // Traversal fails closed before any normalization could hide it.
  if (requestedPath.split(/[/\\]/).includes("..")) return undefined;
  const normalized = toPosix(requestedPath).replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("/")) return undefined;
  return normalized;
}

/** Walks up to the nearest existing directory inside cwd. */
async function nearestExistingDirectory(candidate: string, cwd: string, fileSystem: FileSystem): Promise<string | undefined> {
  let current = candidate;
  while (true) {
    const info = await fileSystem.stat(current).catch(() => undefined);
    if (info?.isDirectory()) {
      const realRoot = await fileSystem.realpath?.(resolve(cwd)).catch(() => undefined);
      const realDirectory = await fileSystem.realpath?.(resolve(current)).catch(() => undefined);
      if (!realRoot || !realDirectory) return undefined;
      const within = relative(realRoot, realDirectory);
      // The cwd itself is a valid search root; anything above it is not.
      if (within.startsWith("..") || isAbsolute(within)) return undefined;
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Collects bounded readable regular-file candidates under one directory tree. */
async function collectRegularFiles(root: string, cwd: string, fileSystem: FileSystem): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
    const directory = queue.shift()!;
    const entries = await fileSystem.readdir(directory).catch(() => []);
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (scanned >= MAX_SCAN_ENTRIES) break;
      scanned++;
      const entryPath = resolve(directory, entry.name);
      const relativePath = toPosix(relative(resolve(cwd), entryPath));
      if (relativePath.startsWith("..")) continue;
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      // Symlink-safe containment: the real path must stay inside cwd.
      const realRoot = await fileSystem.realpath?.(resolve(cwd)).catch(() => undefined);
      const realEntry = await fileSystem.realpath?.(entryPath).catch(() => undefined);
      if (!realRoot || !realEntry) continue;
      const within = relative(realRoot, realEntry);
      if (within === "" || within.startsWith("..") || isAbsolute(within)) continue;
      const info = await fileSystem.stat(entryPath).catch(() => undefined);
      if (!info || info.isDirectory()) continue;
      found.push(relativePath);
    }
  }
  return found;
}

/**
 * Generates at most 5 deterministic relative-path candidates for a missing
 * read. Returns undefined when the requested path is ineligible (absolute,
 * escaping, existing, a directory, or no readable candidates).
 */
export async function generateReadPathCandidates(options: {
  cwd: string;
  requestedPath: string;
  fileSystem?: FileSystem;
}): Promise<CandidatePath[] | undefined> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const requested = requestedRelativePath(options.requestedPath);
  if (!requested) return undefined;

  const resolvedRequested = resolve(options.cwd, requested);
  const existing = await fileSystem.stat(resolvedRequested).catch(() => undefined);
  if (existing) return undefined; // existing files and directory reads are not eligible

  const searchRoot = await nearestExistingDirectory(resolve(resolvedRequested, ".."), options.cwd, fileSystem);
  if (!searchRoot) return undefined;

  const files = await collectRegularFiles(searchRoot, options.cwd, fileSystem);
  const ranked = rankPathCandidates(requested, files).slice(0, MAX_PATH_CANDIDATES);
  if (ranked.length === 0) return undefined;
  return ranked.map((path, index) => ({ ordinal: index + 1, path }));
}

/** Validates a selected candidate: contained realpath plus readable regular file. */
/** Largest file the postcheck reads. A larger known size fails closed. */
export const MAX_POSTCHECK_PROBE_BYTES = 1_048_576;

export async function validateCandidatePath(options: {
  cwd: string;
  candidatePath: string;
  fileSystem?: FileSystem;
}): Promise<string | undefined> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const requested = requestedRelativePath(options.candidatePath);
  if (!requested) return undefined;

  const resolvedCandidate = resolve(options.cwd, requested);
  const realRoot = await fileSystem.realpath?.(resolve(options.cwd)).catch(() => undefined);
  const realCandidate = await fileSystem.realpath?.(resolvedCandidate).catch(() => undefined);
  if (!realRoot || !realCandidate) return undefined;
  const within = relative(realRoot, realCandidate);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return undefined;

  const info = await fileSystem.stat(realCandidate).catch(() => undefined);
  if (!info || info.isDirectory()) return undefined;
  // TASK-0039: never pull an unbounded file into memory for the readability
  // probe, and never accept a file we could not probe. A known size above the
  // cap fails closed: no read, no mutation. Unknown size keeps the read as the
  // documented fallback for injected filesystems.
  const knownSize = typeof info.size === "number" && Number.isFinite(info.size) ? info.size : undefined;
  if (knownSize !== undefined && knownSize > MAX_POSTCHECK_PROBE_BYTES) return undefined;
  const content = await fileSystem.readFile(realCandidate).catch(() => undefined);
  if (content === undefined) return undefined;
  return requested;
}
