/**
 * Benchmark dataset — loads closed guidance episodes (TASK-0007 records),
 * rejects incomplete or content-bearing records, and splits episodes into
 * train/dev/holdout with sealed-holdout access boundaries (contract v2 §12).
 *
 * Pure: no I/O, no clocks, no network.
 */

import { REPAIR_ACTIONS } from "../repairs/types.ts";

export type EpisodeKind = "repair-warning" | "result-repair";
export type EpisodeOutcome = "valid" | "repaired-recurrence" | "repaired-other" | "failed" | "expired";

export interface BenchEpisode {
  episodeId: string;
  kind: EpisodeKind;
  sessionId: string;
  toolName: string;
  repairs: string[];
  inputKeys: string[];
  outcome: EpisodeOutcome;
  provider?: string;
  model?: string;
}

export type RedactedEpisode = Omit<BenchEpisode, "outcome">;

export interface DatasetIssue {
  sessionId?: string;
  episodeId?: string;
  reason: string;
}

export interface EpisodeFileInput {
  sessionId: string;
  events: readonly Record<string, unknown>[];
}

export interface LoadResult {
  episodes: BenchEpisode[];
  rejected: DatasetIssue[];
}

const KINDS: ReadonlySet<string> = new Set(["repair-warning", "result-repair"]);
const OUTCOMES: ReadonlySet<string> = new Set([
  "valid",
  "repaired-recurrence",
  "repaired-other",
  "failed",
  "expired",
]);
const ACTIONS: ReadonlySet<string> = new Set(REPAIR_ACTIONS);
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "ts",
  "eventType",
  "toolName",
  "provider",
  "model",
  "repairs",
  "wasRepaired",
  "inputKeys",
  "episodeId",
  "kind",
  "outcome",
  "window",
  "unrelatedCalls",
]);
/** Content/value fields that must never appear on a bench episode. */
const CONTENT_FIELDS: readonly string[] = [
  "errorText",
  "content",
  "command",
  "code",
  "oldText",
  "newText",
  "path",
  "prompt",
  "text",
];

export function loadEpisodes(sources: readonly EpisodeFileInput[]): LoadResult {
  const episodes: BenchEpisode[] = [];
  const rejected: DatasetIssue[] = [];

  for (const source of sources) {
    for (const event of source.events) {
      if (event["eventType"] !== "episode") continue;
      const issue = toEpisode(source.sessionId, event);
      if (typeof issue === "string") {
        rejected.push({ sessionId: source.sessionId, episodeId: asString(event["episodeId"]), reason: issue });
      } else if (issue) {
        episodes.push(issue);
      }
    }
  }
  return { episodes, rejected };
}

function toEpisode(sessionId: string, event: Record<string, unknown>): BenchEpisode | string | null {
  const episodeId = asString(event["episodeId"]);
  for (const field of CONTENT_FIELDS) {
    if (event[field] !== undefined) return `content-bearing-episode:${field}`;
  }
  for (const field of Object.keys(event)) {
    if (!ALLOWED_FIELDS.has(field)) return `unexpected-field:${field}`;
  }
  if (!episodeId) return "incomplete-episode:episodeId";
  const toolName = asString(event["toolName"]);
  if (!toolName) return "incomplete-episode:toolName";
  const kind = asString(event["kind"]);
  if (!kind || !KINDS.has(kind)) return "incomplete-episode:kind";
  const outcome = asString(event["outcome"]);
  if (!outcome || !OUTCOMES.has(outcome)) return "incomplete-episode:outcome";
  const repairs = event["repairs"];
  if (!Array.isArray(repairs) || repairs.length === 0) return "incomplete-episode:repairs";
  for (const action of repairs) {
    if (typeof action !== "string" || !ACTIONS.has(action)) return `unknown-repair-action:${String(action)}`;
  }

  return {
    episodeId,
    kind: kind as EpisodeKind,
    sessionId,
    toolName,
    repairs: repairs as string[],
    inputKeys: Array.isArray(event["inputKeys"]) ? (event["inputKeys"] as string[]) : [],
    outcome: outcome as EpisodeOutcome,
    ...(event["provider"] !== undefined ? { provider: asString(event["provider"]) } : {}),
    ...(event["model"] !== undefined ? { model: asString(event["model"]) } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function redact(episode: BenchEpisode): RedactedEpisode {
  const { outcome: _outcome, ...rest } = episode;
  return rest;
}

export interface SealedHoldout {
  /** Label-free view — safe to hand to train/dev phases. */
  readonly redacted: readonly RedactedEpisode[];
  /** Final evaluation access. Throws once `seal()` was called. */
  unseal(): readonly BenchEpisode[];
  /** Permanently revoke unseal access (enforced lockdown). */
  seal(): void;
}

export interface Split {
  train: BenchEpisode[];
  dev: BenchEpisode[];
  holdout: SealedHoldout;
}

export interface SplitOptions {
  trainFrac?: number;
  devFrac?: number;
}

/** Time/session-ordered contiguous split (contract v2 §12); ties by session id. */
export function splitEpisodes(episodes: readonly BenchEpisode[], options: SplitOptions = {}): Split {
  const trainFrac = options.trainFrac ?? 0.6;
  const devFrac = options.devFrac ?? 0.2;
  const bySession = new Map<string, BenchEpisode[]>();
  for (const episode of episodes) {
    const list = bySession.get(episode.sessionId) ?? [];
    list.push(episode);
    bySession.set(episode.sessionId, list);
  }
  const sessionIds = Array.from(bySession.keys()).sort();
  const trainCount = Math.floor(sessionIds.length * trainFrac);
  const devCount = Math.floor(sessionIds.length * devFrac);

  const train: BenchEpisode[] = [];
  const dev: BenchEpisode[] = [];
  const holdoutEpisodes: BenchEpisode[] = [];
  sessionIds.forEach((id, index) => {
    const list = bySession.get(id) ?? [];
    if (index < trainCount) train.push(...list);
    else if (index < trainCount + devCount) dev.push(...list);
    else holdoutEpisodes.push(...list);
  });

  let sealed = false;
  const redacted = holdoutEpisodes.map(redact);
  return {
    train,
    dev,
    holdout: {
      redacted,
      unseal() {
        if (sealed) throw new Error("sealed holdout: access was permanently revoked");
        return holdoutEpisodes;
      },
      seal() {
        sealed = true;
      },
    },
  };
}
