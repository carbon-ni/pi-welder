import { createHash } from "node:crypto";

/**
 * TASK-0043 — pure two-file missing-read heuristic (offline analysis only).
 *
 * The model asks for a file that does not exist. When the requested file's
 * parent directory holds exactly two regular files, could one of them be the
 * intended target? This module answers that question with predeclared,
 * conservative rules and no filesystem access. It is not wired into the runtime:
 * nothing here changes tool behavior, and it persists no paths or names.
 *
 * Rules, in order (first match wins):
 *   1. explicit test/spec vs implementation pair -> the counterpart;
 *   2. same normalized stem, different extension  -> that file;
 *   3. unique normalized-name distance            -> only past a predeclared
 *      ratio margin, so unrelated names abstain;
 *   4. an extension match alone never selects.
 */

/** A normalized name must be within 34% edit distance of the requested name. */
export const MAX_DISTANCE_RATIO = 0.34;
/** The best candidate must beat the runner-up by at least 15%. */
export const MIN_MARGIN_RATIO = 0.15;
/** Below this many provisional labels the evidence is insufficient. */
export const MIN_PROVISIONAL_LABELS = 30;
/** At most this many later reads may supply an observation. */
export const LOOKAHEAD_READS = 3;

export type TwoFileReason =
  | "test-spec-counterpart"
  | "stem-extension-variant"
  | "unique-distance"
  | "extension-only"
  | "distance-too-far"
  | "ambiguous-distance"
  | "no-rule-matched";

export interface TwoFileSelection {
  action: "select" | "abstain";
  /** In-memory only: never persisted by the miner or the summary. */
  file?: string;
  reason: TwoFileReason;
}

const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /(^|[._-])test(s)?([._-]|$)/i,
  /(^|[._-])spec(s)?([._-]|$)/i,
];

/** True for names that conventionally hold tests or specs. */
export function isTestOrSpecName(name: string): boolean {
  const stem = name.replace(/\.[^.]+$/, "");
  return TEST_NAME_PATTERNS.some((pattern) => pattern.test(stem));
}

/** Lowercase, separator-free, test-marker-free stem used for comparisons. */
export function normalizeFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[._-]+/g, "")
    .replace(/^(test|spec)s?/, "")
    .replace(/(test|spec)s?$/, "");
}

/** The lowercased extension without the dot, or "" when there is none. */
export function extensionOf(name: string): string {
  const match = name.match(/\.([^.]+)$/);
  return match ? match[1]!.toLowerCase() : "";
}

/** Levenshtein distance over two strings. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const rows: number[] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = rows[0]!;
    rows[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = rows[j]!;
      rows[j] = Math.min(rows[j - 1]! + 1, above + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return rows[right.length]!;
}

/** Edit distance over normalized names, as a ratio of the longer length. */
export function distanceRatio(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  return editDistance(left, right) / longest;
}

/**
 * Chooses between exactly two regular files, or abstains. `files` must be the
 * two names of the requested file's parent directory.
 */
export function selectTwoFileCandidate(requestedName: string, files: readonly string[]): TwoFileSelection {
  if (files.length !== 2) return { action: "abstain", reason: "no-rule-matched" };

  const requestedStem = normalizeFileName(requestedName);
  const requestedIsTest = isTestOrSpecName(requestedName);
  const requestedExtension = extensionOf(requestedName);

  // 1. Explicit test/spec vs implementation pair: pick the counterpart.
  for (const candidate of files) {
    if (normalizeFileName(candidate) !== requestedStem) continue;
    if (isTestOrSpecName(candidate) === requestedIsTest) continue;
    return { action: "select", file: candidate, reason: "test-spec-counterpart" };
  }

  // 2. Same normalized stem, different extension.
  const stemMatches = files.filter(
    (candidate) => normalizeFileName(candidate) === requestedStem && extensionOf(candidate) !== requestedExtension,
  );
  if (stemMatches.length === 1) return { action: "select", file: stemMatches[0]!, reason: "stem-extension-variant" };
  if (stemMatches.length > 1) return { action: "abstain", reason: "ambiguous-distance" };

  // 3. Unique normalized-name distance, past a predeclared conservative margin.
  const ranked = files
    .map((file) => ({ file, ratio: distanceRatio(requestedStem, normalizeFileName(file)) }))
    .sort((left, right) => left.ratio - right.ratio || left.file.localeCompare(right.file));
  const best = ranked[0]!;
  const runnerUp = ranked[1]!;
  // A shared extension never selects on its own: the names must be close enough
  // and clearly closer than the alternative.
  if (best.ratio > MAX_DISTANCE_RATIO) return { action: "abstain", reason: "distance-too-far" };
  if (runnerUp.ratio - best.ratio < MIN_MARGIN_RATIO) return { action: "abstain", reason: "ambiguous-distance" };
  return { action: "select", file: best.file, reason: "unique-distance" };
}

/** True when an error message reads as a missing file. */
export function isMissingError(message: string): boolean {
  return /ENOENT|no such file|does not exist|not found/i.test(message);
}

/**
 * One `read` call from a session, in order, with the recorded outcome and the
 * raw result text (used only to read the historical directory snapshot).
 */
export interface SessionReadCall {
  /** In-memory only: hashed before anything is persisted. */
  identifier: string;
  /** In-memory only. */
  path: string;
  isError: boolean;
  /** True when the failure was a missing file (ENOENT-ish). */
  missing: boolean;
  /** The tool result text as recorded, or "" when there was none. */
  resultText: string;
}

/** A directory snapshot taken from a historical missing-read error message. */
export interface MissingReadSnapshot {
  /** Absolute directory the snapshot was taken from. */
  root: string;
  /** Direct regular-file names only; directories are excluded. */
  directFiles: string[];
  truncated: boolean;
}

const TREE_ENTRY = /^[│ ]*(?:├──|└──) (.*)$/;

/**
 * Parses the `missing-read-context` enrichment out of a failed read's result
 * text. Returns undefined for anything unexpected: no `Tree from:` line, a
 * missing `.` marker, or a snapshot that was cut short. The miner never uses
 * the current filesystem, so an unusable snapshot means "ineligible".
 */
export function parseMissingReadSnapshot(text: string): MissingReadSnapshot | undefined {
  const lines = text.split("\n");
  const treeIndex = lines.findIndex((line) => line.startsWith("Tree from: "));
  if (treeIndex === -1) return undefined;

  const root = lines[treeIndex]!.slice("Tree from: ".length).trim();
  if (root === "" || lines[treeIndex + 1]?.trim() !== ".") return undefined;

  const directFiles: string[] = [];
  for (const line of lines.slice(treeIndex + 2)) {
    if (line.startsWith("…")) return { root, directFiles, truncated: true };
    const entry = line.match(TREE_ENTRY);
    if (!entry) continue;
    const name = entry[1]!.trimEnd();
    // Deeper entries carry a four-character indent prefix.
    const depth = (/^[│ ]*/.exec(line)?.[0].length ?? 0) === 0;
    if (!depth) continue;
    if (name.endsWith("/")) continue;
    directFiles.push(name);
  }
  return { root, directFiles, truncated: false };
}

/** Normalizes separators and `.`/`..` segments without touching the filesystem. */
export function normalizePath(input: string, cwd: string): string {
  const unified = input.trim().replace(/\\/g, "/");
  const cwdUnified = cwd.trim().replace(/\\/g, "/");
  const inputDrive = unified.match(/^([A-Za-z]:)\//)?.[1] ?? "";
  const cwdDrive = cwdUnified.match(/^([A-Za-z]:)\//)?.[1] ?? "";
  const drive = inputDrive !== "" ? inputDrive : cwdDrive;
  const absolute = inputDrive !== "" || unified.startsWith("/");
  const combined = absolute ? unified.slice(inputDrive.length) : `${cwdUnified.slice(cwdDrive.length)}/${unified}`;

  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join("/");
  if (drive !== "") return `${drive}/${joined}`;
  return combined.startsWith("/") ? `/${joined}` : joined;
}

/** The directory a requested path names, normalized. */
export function parentDirectoryOf(requestedPath: string, cwd: string): string {
  const normalized = normalizePath(requestedPath, cwd);
  const separator = normalized.lastIndexOf("/");
  if (separator === -1) return ".";
  return normalized.slice(0, separator) || "/";
}

/**
 * Collision-resistant opaque identifier. Parts are length-prefixed and
 * separator-joined before hashing, so `["ab","c"]` and `["a","bc"]` differ.
 */
export function opaqueId(parts: readonly string[]): string {
  const framed = parts.map((part) => `${part.length}:${part}`).join("\u0000");
  return createHash("sha256").update(framed).digest("hex").slice(0, 32);
}

/** Closed feature set: booleans and one banded ratio. Never names. */
export interface TwoFileFeatures {
  testSpecPair: boolean;
  stemExtensionVariant: boolean;
  distanceBand: "exact" | "close" | "far";
}

export type TwoFileOutcome = "correct" | "wrong" | "unresolved";

/** One mined episode. Contains no paths, names, cwd, or error text. */
export interface TwoFileRecord {
  sessionId: string;
  callId: string;
  candidateCount: 2;
  features: TwoFileFeatures;
  prediction: { ordinal: number; reason: TwoFileReason };
  observed: { ordinal: number } | null;
  outcome: TwoFileOutcome;
}

export interface TwoFileMiningResult {
  records: TwoFileRecord[];
  sessionsScanned: number;
  sessionsWithReads: number;
  readCalls: number;
  missingReads: number;
  snapshotIneligible: number;
}

/** One session: its recorded cwd plus its ordered `read` calls. */
export interface SessionInput {
  /** In-memory only: hashed into every record. */
  sessionKey: string;
  cwd: string;
  calls: readonly SessionReadCall[];
}

function featuresFor(requestedName: string, files: readonly string[], reason: TwoFileReason): TwoFileFeatures {
  const requestedStem = normalizeFileName(requestedName);
  const ratios = files.map((file) => distanceRatio(requestedStem, normalizeFileName(file)));
  const best = Math.min(...ratios);
  return {
    testSpecPair: reason === "test-spec-counterpart",
    stemExtensionVariant: reason === "stem-extension-variant",
    distanceBand: best === 0 ? "exact" : best <= MAX_DISTANCE_RATIO ? "close" : "far",
  };
}

/**
 * Mines two-file selections from historical snapshots. A call is eligible only
 * when its own error message carries an untruncated snapshot whose root is the
 * requested file's parent and whose direct entries hold exactly two regular
 * files. A prediction is observed only when one of the next three read calls
 * succeeded on one of those two files; otherwise it is unresolved, never wrong.
 */
export function mineTwoFileSelections(sessions: readonly SessionInput[]): TwoFileMiningResult {
  const records: TwoFileRecord[] = [];
  let readCalls = 0;
  let missingReads = 0;
  let snapshotIneligible = 0;
  let sessionsWithReads = 0;

  for (const session of sessions) {
    readCalls += session.calls.length;
    if (session.calls.length > 0) sessionsWithReads += 1;

    session.calls.forEach((call, index) => {
      if (!call.isError || !call.missing) return;
      missingReads += 1;

      const snapshot = parseMissingReadSnapshot(call.resultText);
      if (!snapshot || snapshot.truncated) {
        snapshotIneligible += 1;
        return;
      }
      if (parentDirectoryOf(call.path, session.cwd) !== normalizePath(snapshot.root, session.cwd)) {
        snapshotIneligible += 1;
        return;
      }
      if (snapshot.directFiles.length !== 2) {
        snapshotIneligible += 1;
        return;
      }

      const candidates = [...snapshot.directFiles].sort((left, right) => left.localeCompare(right));
      const separator = call.path.lastIndexOf("/");
      const requestedName = normalizePath(call.path, session.cwd).slice(normalizePath(call.path, session.cwd).lastIndexOf("/") + 1);
      void separator;
      const selection = selectTwoFileCandidate(requestedName, candidates);
      if (selection.action !== "select" || selection.file === undefined) return;

      const predictionOrdinal = candidates.indexOf(selection.file) + 1;
      const root = normalizePath(snapshot.root, session.cwd);
      const observedOrdinal = session.calls
        .slice(index + 1, index + 1 + LOOKAHEAD_READS)
        .map((later) => (later.isError ? undefined : candidates.findIndex((file) => normalizePath(later.path, session.cwd) === `${root}/${file}`)))
        .find((ordinal) => ordinal !== undefined && ordinal >= 0);

      const observed = observedOrdinal === undefined ? null : { ordinal: observedOrdinal + 1 };
      records.push({
        sessionId: opaqueId([session.sessionKey]),
        callId: opaqueId([session.sessionKey, call.identifier, call.path]),
        candidateCount: 2,
        features: featuresFor(requestedName, candidates, selection.reason),
        prediction: { ordinal: predictionOrdinal, reason: selection.reason },
        observed,
        outcome: observed === null ? "unresolved" : observed.ordinal === predictionOrdinal ? "correct" : "wrong",
      });
    });
  }

  return { records, sessionsScanned: sessions.length, sessionsWithReads, readCalls, missingReads, snapshotIneligible };
}

export interface TwoFileSummary {
  sessionsScanned: number;
  sessionsWithReads: number;
  readCalls: number;
  missingReads: number;
  snapshotIneligible: number;
  selections: number;
  observedLabels: number;
  unresolved: number;
  labelsCorrect: number;
  labelsWrong: number;
  precision: number | undefined;
  attrition: { stage: string; remaining: number }[];
  reasons: { reason: TwoFileReason; count: number }[];
  sessionConcentration: { contributingSessions: number; maxLabelsInOneSession: number };
  insufficient: boolean;
}

/**
 * Metadata-only summary. `precision` uses only observed labels as its
 * denominator: a selection nobody ever read cannot be judged, so it counts as
 * unresolved rather than as a mistake.
 */
export function summarizeTwoFileMining(
  mined: TwoFileMiningResult,
  minimumLabels = MIN_PROVISIONAL_LABELS,
): TwoFileSummary {
  const observed = mined.records.filter((record) => record.observed !== null);
  const correct = observed.filter((record) => record.outcome === "correct").length;

  const reasonCounts = new Map<TwoFileReason, number>();
  for (const record of mined.records) {
    reasonCounts.set(record.prediction.reason, (reasonCounts.get(record.prediction.reason) ?? 0) + 1);
  }

  const perSession = new Map<string, number>();
  for (const record of observed) perSession.set(record.sessionId, (perSession.get(record.sessionId) ?? 0) + 1);

  return {
    sessionsScanned: mined.sessionsScanned,
    sessionsWithReads: mined.sessionsWithReads,
    readCalls: mined.readCalls,
    missingReads: mined.missingReads,
    snapshotIneligible: mined.snapshotIneligible,
    selections: mined.records.length,
    observedLabels: observed.length,
    unresolved: mined.records.length - observed.length,
    labelsCorrect: correct,
    labelsWrong: observed.length - correct,
    precision: observed.length === 0 ? undefined : correct / observed.length,
    attrition: [
      { stage: "sessions", remaining: mined.sessionsScanned },
      { stage: "sessions-with-reads", remaining: mined.sessionsWithReads },
      { stage: "read-calls", remaining: mined.readCalls },
      { stage: "missing-reads", remaining: mined.missingReads },
      { stage: "snapshot-eligible", remaining: mined.missingReads - mined.snapshotIneligible },
      { stage: "selections", remaining: mined.records.length },
      { stage: "observed-labels", remaining: observed.length },
      { stage: "labels-correct", remaining: correct },
    ],
    reasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    sessionConcentration: {
      contributingSessions: perSession.size,
      maxLabelsInOneSession: perSession.size === 0 ? 0 : Math.max(...perSession.values()),
    },
    insufficient: observed.length < minimumLabels,
  };
}
