import { isAbsolute, relative, resolve } from "node:path";
import type { FileSystem } from "../infra/filesystem.ts";
import { nodeFileSystem } from "../infra/filesystem.ts";

export const MAX_SOURCE_BYTES = 200_000;
export const MAX_CANDIDATES = 5;
export const MAX_CANDIDATE_LINES = 20;
export const MAX_CANDIDATE_BYTES = 2 * 1024;
export const MAX_SERIALIZED_BYTES = 12 * 1024;

export interface ShadowCandidate {
  ordinal: number;
  window: string;
}

export interface AmbiguousShadowRequest {
  candidates: ShadowCandidate[];
  requestedEditText: string;
  serializedBytes: number;
}

export interface BuildAmbiguousShadowOptions {
  cwd: string;
  toolInput: Record<string, unknown>;
  fileSystem?: FileSystem;
  sanitize?: (value: string) => string | undefined;
}

/**
 * Contained read of a tool-input path: the file's real path must lie strictly
 * inside the cwd's real path, and the content must fit the source byte cap.
 * Single-sourced so live shadowing and offline replay (TASK-0024) cannot
 * drift apart on containment or size semantics.
 */
export async function readContainedSource(
  options: { cwd: string; target: string; fileSystem?: FileSystem },
): Promise<string | undefined> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  // Symlink-safe containment: the file's real path must lie strictly inside
  // the cwd's real path. Unreadable, escaping, or equal-to-root paths are
  // never transmitted.
  const realRoot = await fileSystem.realpath?.(resolve(options.cwd)).catch(() => undefined);
  const realFile = await fileSystem.realpath?.(resolve(options.cwd, options.target)).catch(() => undefined);
  if (!realRoot || !realFile) return undefined;
  const withinRoot = relative(realRoot, realFile);
  if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) return undefined;

  const current = await fileSystem.readFile(realFile).catch(() => undefined);
  if (current === undefined || Buffer.byteLength(current, "utf8") > MAX_SOURCE_BYTES) return undefined;
  return current;
}

/** Exact, non-overlapping occurrence offsets of a value inside content. */
export function occurrenceOffsets(content: string, value: string): number[] {
  const offsets: number[] = [];
  for (let from = 0; (from = content.indexOf(value, from)) !== -1; from += value.length) offsets.push(from);
  return offsets;
}

/**
 * Finds a single edit whose exact locator has 2–5 occurrences. This helper is
 * intentionally conservative: it never returns a request for malformed,
 * multi-edit, unreadable, oversized, or unsafely sanitized input.
 */
export async function buildAmbiguousShadowRequest(
  options: BuildAmbiguousShadowOptions,
): Promise<AmbiguousShadowRequest | undefined> {
  const parsed = parseSingleEdit(options.toolInput);
  if (!parsed) return undefined;

  const target = options.toolInput.path;
  if (typeof target !== "string") return undefined;

  const current = await readContainedSource({ cwd: options.cwd, target, fileSystem: options.fileSystem });
  if (current === undefined) return undefined;

  const offsets = occurrenceOffsets(current, parsed.oldText);
  if (offsets.length < 2 || offsets.length > MAX_CANDIDATES) return undefined;

  const sanitize = options.sanitize ?? redactShadowText;
  const candidates: ShadowCandidate[] = [];
  for (const [index, offset] of offsets.entries()) {
    const rawWindow = candidateWindow(current, parsed.oldText, offset);
    if (!rawWindow) return undefined;
    const window = sanitize(rawWindow);
    const redactedOldText = redactShadowText(parsed.oldText);
    if (window === undefined || redactedOldText === undefined || !withinWindowCaps(window) || !window.includes(redactedOldText)) {
      return undefined;
    }
    candidates.push({ ordinal: index + 1, window });
  }

  const requestedEditText = sanitize(parsed.newText);
  if (requestedEditText === undefined) return undefined;
  const state = { candidates, requestedEditText };
  const serializedBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  if (serializedBytes > MAX_SERIALIZED_BYTES) return undefined;
  return { candidates, requestedEditText, serializedBytes };
}

function parseSingleEdit(value: Record<string, unknown>): { oldText: string; newText: string } | undefined {
  if (!Array.isArray(value.edits) || value.edits.length !== 1) return undefined;
  const edit = value.edits[0];
  if (!edit || typeof edit !== "object") return undefined;
  const oldText = (edit as Record<string, unknown>).oldText;
  const newText = (edit as Record<string, unknown>).newText;
  if (typeof oldText !== "string" || typeof newText !== "string" || oldText.length === 0) return undefined;
  return { oldText, newText };
}

function candidateWindow(content: string, oldText: string, offset: number): string | undefined {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") lineStarts.push(index + 1);
  }
  const lineAt = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= position) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(0, high);
  };
  const lines = content.split("\n");
  const firstLine = lineAt(offset);
  const lastLine = lineAt(offset + oldText.length - 1);
  if (lastLine - firstLine + 1 > MAX_CANDIDATE_LINES) return undefined;

  let first = firstLine;
  let last = lastLine;
  while (last - first + 1 < MAX_CANDIDATE_LINES && (first > 0 || last < lines.length - 1)) {
    if (first > 0) first--;
    if (last - first + 1 < MAX_CANDIDATE_LINES && last < lines.length - 1) last++;
    const value = lines.slice(first, last + 1).join("\n");
    if (Buffer.byteLength(value, "utf8") > MAX_CANDIDATE_BYTES) {
      if (last > lastLine) last--;
      else if (first < firstLine) first++;
      break;
    }
  }
  const window = lines.slice(first, last + 1).join("\n");
  return withinWindowCaps(window) && window.includes(oldText) ? window : undefined;
}

function withinWindowCaps(value: string): boolean {
  return value.split("\n").length <= MAX_CANDIDATE_LINES && Buffer.byteLength(value, "utf8") <= MAX_CANDIDATE_BYTES;
}

/** Deterministic, allowlist-oriented redaction for common credential forms. */
export function redactShadowText(value: string): string | undefined {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return undefined;
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/giu, "<redacted>")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu, "<redacted>")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?)([^\s"',;}]+)/giu, "$1<redacted>");
}
