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

/**
 * The directory a requested path names. One definition, used by both the miner
 * and the CLI that primes directory listings, so they cannot disagree.
 */
export function parentDirectoryOf(requestedPath: string): string {
  const separator = Math.max(requestedPath.lastIndexOf("/"), requestedPath.lastIndexOf("\\"));
  if (separator === -1) return ".";
  return requestedPath.slice(0, separator) || "/";
}

/** One `read` call from a session, in order, with the outcome we observed. */
export interface SessionReadCall {
  identifier: string;
  /** In-memory only. */
  path: string;
  isError: boolean;
  /** True when the failure was a missing file (ENOENT-ish). */
  missing: boolean;
}

export interface TwoFileEpisode {
  sessionKey: string;
  reason: TwoFileReason;
  selected: boolean;
  /** The first later successful read that matches a listed file, if any. */
  labelledCorrect: boolean;
}

export interface TwoFileSummary {
  sessionsScanned: number;
  readCalls: number;
  missingReads: number;
  ineligibleScope: number;
  selections: number;
  abstentions: number;
  labels: number;
  labelsCorrect: number;
  precision: number | undefined;
  attrition: { stage: string; remaining: number }[];
  reasons: { reason: TwoFileReason; count: number }[];
  sessionConcentration: { contributingSessions: number; maxLabelsInOneSession: number };
  insufficient: boolean;
}

const LOOKAHEAD_READS = 3;

/** True when an error message reads as a missing file. */
export function isMissingError(message: string): boolean {
  return /ENOENT|no such file|does not exist|not found/i.test(message);
}

/**
 * Mines two-file selections from ordered session read calls. `directoryListing`
 * returns the current regular files of a directory, or undefined when it cannot
 * be read; it is injected so this stays pure and testable.
 */
export function mineTwoFileSelections(
  sessions: readonly { sessionKey: string; calls: readonly SessionReadCall[] }[],
  directoryListing: (directory: string) => readonly string[] | undefined,
): { episodes: TwoFileEpisode[]; missingReads: number; ineligibleScope: number; readCalls: number } {
  const episodes: TwoFileEpisode[] = [];
  let missingReads = 0;
  let ineligibleScope = 0;
  let readCalls = 0;

  for (const session of sessions) {
    readCalls += session.calls.length;
    session.calls.forEach((call, index) => {
      if (!call.isError || !call.missing) return;
      missingReads += 1;

      const directory = parentDirectoryOf(call.path);
      const files = directoryListing(directory);
      if (files === undefined || files.length !== 2) {
        ineligibleScope += 1;
        return;
      }

      const separator = call.path.lastIndexOf("/");
      const requestedName = separator === -1 ? call.path : call.path.slice(separator + 1);
      const selection = selectTwoFileCandidate(requestedName, files);
      if (selection.action !== "select") {
        episodes.push({ sessionKey: session.sessionKey, reason: selection.reason, selected: false, labelledCorrect: false });
        return;
      }

      // Only a later successful read of one of the two files is a real signal.
      const lookahead = session.calls.slice(index + 1, index + 1 + LOOKAHEAD_READS);
      const observed = lookahead.find(
        (later) => !later.isError && files.some((file) => later.path === file || later.path.endsWith(`/${file}`)),
      );
      episodes.push({
        sessionKey: session.sessionKey,
        reason: selection.reason,
        selected: true,
        labelledCorrect: observed !== undefined && observed.path.endsWith(selection.file!) && selection.file !== undefined,
      });
    });
  }

  return { episodes, missingReads, ineligibleScope, readCalls };
}

/** Metadata-only summary: counts, ratios, and shape. Never paths or names. */
export function summarizeTwoFileMining(
  mined: { episodes: readonly TwoFileEpisode[]; missingReads: number; ineligibleScope: number; readCalls: number },
  sessionsScanned: number,
  minimumLabels = MIN_PROVISIONAL_LABELS,
): TwoFileSummary {
  const selections = mined.episodes.filter((episode) => episode.selected);
  const labels = selections.length;
  const labelsCorrect = selections.filter((episode) => episode.labelledCorrect).length;

  const reasonCounts = new Map<TwoFileReason, number>();
  for (const episode of mined.episodes) reasonCounts.set(episode.reason, (reasonCounts.get(episode.reason) ?? 0) + 1);

  const perSession = new Map<string, number>();
  for (const episode of selections) perSession.set(episode.sessionKey, (perSession.get(episode.sessionKey) ?? 0) + 1);

  return {
    sessionsScanned,
    readCalls: mined.readCalls,
    missingReads: mined.missingReads,
    ineligibleScope: mined.ineligibleScope,
    selections: labels,
    abstentions: mined.episodes.length - labels,
    labels,
    labelsCorrect,
    precision: labels === 0 ? undefined : labelsCorrect / labels,
    attrition: [
      { stage: "sessions", remaining: sessionsScanned },
      { stage: "read-calls", remaining: mined.readCalls },
      { stage: "missing-reads", remaining: mined.missingReads },
      { stage: "exact-two-files", remaining: mined.missingReads - mined.ineligibleScope },
      { stage: "selections", remaining: labels },
      { stage: "labelled-by-later-read", remaining: labelsCorrect },
    ],
    reasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    sessionConcentration: {
      contributingSessions: perSession.size,
      maxLabelsInOneSession: perSession.size === 0 ? 0 : Math.max(...perSession.values()),
    },
    insufficient: labels < minimumLabels,
  };
}
