/**
 * TASK-0010 — offline repair-transparency message experiment (contract v2).
 *
 * Governance:
 * - First gate: data sufficiency — >= MIN_HOLDOUT_PER_CLUSTER sealed-holdout
 *   episodes per repair-action cluster (label-free counts via the redacted
 *   holdout view). Below threshold → explicit NO-GO; no winner, no runtime
 *   change, no holdout label access.
 * - Candidate search runs on train/dev only; the holdout is unsealed once for
 *   final scoring. Generic recovery and repair-free messaging are structurally
 *   ineligible (lab/baseline validators).
 * - No-message is a valid winner: ties break toward minimum message cost.
 * - Offline (no model client) candidates cannot alter recorded outcomes, so a
 *   tie with B0 is the expected honest result; `runTransparencyExperimentWithModel`
 *   conditions holdout scoring through the TASK-0008 runner with its caps.
 *   Real-model runs stay opt-in, mocked in tests, and write ignored artifacts.
 */

import { loadEpisodes, splitEpisodes, type BenchEpisode, type EpisodeFileInput } from "./dataset.ts";
import { searchTemplates, generateTemplateMessage, type TemplateParams } from "./lab.ts";
import { NO_MESSAGE, SHIPPED, validateCandidateMessage, type BenchCandidate } from "./baselines.ts";
import { runReplayWithModel, type ModelClient, type RunnerCaps } from "./runner.ts";

export const MIN_HOLDOUT_PER_CLUSTER = 30;
export type { EpisodeFileInput };

export interface ClusterSufficiency {
  action: string;
  holdoutCount: number;
  sufficient: boolean;
}

export interface ExperimentDecision {
  decision: "no-go" | "proceed";
  reason?: string;
  perAction: ClusterSufficiency[];
  threshold: number;
}

export interface ExperimentSearchSummary {
  seed: number;
  bestId: string | null;
  bestScore: number;
  bestAvgLength: number;
  staticScore: number;
  evaluations: number;
}

export interface ClusterMetrics {
  episodes: number;
  observed: number;
  nrr: number;
  recurrencePerCall: number;
  messageTokens: number;
  safetyGates: string[];
}

export interface ExperimentResult extends ExperimentDecision {
  search?: ExperimentSearchSummary;
  /** candidateId → per-action metrics (proceed path only). */
  holdout?: Record<string, Record<string, ClusterMetrics>>;
  winner: string | null;
  winnerParams?: TemplateParams;
}

export interface ExperimentOptions {
  seed?: number;
  threshold?: number;
  maxCandidates?: number;
}

export interface ModelExperimentOptions extends ExperimentOptions {
  modelClient: ModelClient;
  caps: RunnerCaps;
}

// --- sufficiency gate -----------------------------------------------------------

function loadSplit(sources: readonly EpisodeFileInput[]) {
  const { episodes, rejected } = loadEpisodes(sources);
  const split = splitEpisodes(episodes);
  return { episodes, rejected, split };
}

/** Label-free sufficiency audit: redacted holdout counts per action cluster. */
export function auditHoldout(sources: readonly EpisodeFileInput[], options: ExperimentOptions = {}): ExperimentDecision {
  const threshold = options.threshold ?? MIN_HOLDOUT_PER_CLUSTER;
  const { split } = loadSplit(sources);
  const counts = new Map<string, number>();
  for (const episode of split.holdout.redacted) {
    for (const action of episode.repairs) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  const perAction = Array.from(counts.keys()).sort().map((action) => ({
    action,
    holdoutCount: counts.get(action)!,
    sufficient: (counts.get(action) ?? 0) >= threshold,
  }));
  const sufficient = perAction.length > 0 && perAction.every((c) => c.sufficient);
  return {
    decision: sufficient ? "proceed" : "no-go",
    reason: sufficient ? undefined : "insufficient-data: sealed-holdout episodes per repair-action cluster below threshold",
    perAction,
    threshold,
  };
}

// --- candidate space -------------------------------------------------------------

interface MessageCandidate extends BenchCandidate {
  params?: TemplateParams;
}

function experimentCandidates(bestParams: TemplateParams | null): MessageCandidate[] {
  const candidates: MessageCandidate[] = [NO_MESSAGE, { id: "B1-shipped", message: (e) => SHIPPED.message(e) }];
  if (bestParams) {
    candidates.push({
      id: `template:${bestParams.header}-${bestParams.bullet}-keys:${bestParams.includeKeys}-why:${bestParams.includeWhy}`,
      params: bestParams,
      message: (e) => generateTemplateMessage(bestParams, e),
    });
  }
  return candidates;
}

// B1 text comes straight from the shipped baseline (single source of truth).

const TOKENS_PER_CHAR = 0.25; // ~4 chars/token offline estimate

function estimateTokens(message: string | null): number {
  return message === null ? 0 : Math.ceil(message.length * TOKENS_PER_CHAR);
}

function successOf(episode: BenchEpisode): boolean {
  return episode.kind === "repair-warning" ? episode.outcome !== "repaired-recurrence" : episode.outcome === "valid";
}

function safetyGatesFor(candidate: BenchCandidate, group: readonly BenchEpisode[]): string[] {
  const gates = new Set<string>();
  let messaged = 0;
  for (const episode of group) {
    const message = candidate.message(episode);
    if (message === null) continue;
    messaged++;
    if (validateCandidateMessage({ kind: episode.kind, repairs: episode.repairs }, message) === null) {
      gates.add("no-generic-recovery");
      gates.add("references-repair-action");
      gates.add("length<=480");
    }
  }
  if (messaged === 0) gates.add("no-message");
  gates.add("zero-content-record");
  return Array.from(gates).sort();
}

function recordedMetrics(candidate: BenchCandidate, group: readonly BenchEpisode[]): ClusterMetrics {
  let observed = 0;
  let successes = 0;
  let recurrence = 0;
  let tokens = 0;
  for (const episode of group) {
    if (episode.outcome === "expired") continue;
    observed++;
    if (successOf(episode)) successes++;
    if (episode.outcome === "repaired-recurrence") recurrence++;
    tokens += estimateTokens(candidate.message(episode));
  }
  return {
    episodes: group.length,
    observed,
    nrr: observed === 0 ? 0 : successes / observed,
    recurrencePerCall: observed === 0 ? 0 : recurrence / observed,
    messageTokens: tokens,
    safetyGates: safetyGatesFor(candidate, group),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pickWinner(holdout: Record<string, Record<string, ClusterMetrics>>): string | null {
  const ids = Object.keys(Object.values(holdout)[0] ?? {});
  const meanNrr = new Map(ids.map((id) => [id, mean(Object.values(holdout).map((m) => m[id]!.nrr))]));
  const totalTokens = new Map(ids.map((id) => [id, Object.values(holdout).reduce((sum, m) => sum + m[id]!.messageTokens, 0)]));
  let winner: string | null = null;
  for (const id of ids) {
    if (winner === null) {
      winner = id;
      continue;
    }
    const nrr = meanNrr.get(id)!;
    const bestNrr = meanNrr.get(winner)!;
    if (nrr > bestNrr + 1e-9) {
      winner = id;
    } else if (Math.abs(nrr - bestNrr) <= 1e-9) {
      const tokens = totalTokens.get(id)!;
      const bestTokens = totalTokens.get(winner)!;
      if (tokens < bestTokens || (tokens === bestTokens && id === "B0-no-message")) winner = id;
    }
  }
  return winner;
}

// --- experiment ------------------------------------------------------------------

export function runTransparencyExperiment(sources: readonly EpisodeFileInput[], options: ExperimentOptions = {}): ExperimentResult {
  const threshold = options.threshold ?? MIN_HOLDOUT_PER_CLUSTER;
  const decision = auditHoldout(sources, { threshold });
  if (decision.decision === "no-go") {
    return { ...decision, winner: null };
  }

  const { split } = loadSplit(sources);
  // Search on train only; dev reserved for candidate pruning in later tasks.
  const search = searchTemplates(split.train, { seed: options.seed ?? 42, maxCandidates: options.maxCandidates ?? 16 });
  const candidates = experimentCandidates(search.best?.params ?? null);

  // Unseal once, for final scoring only.
  const holdoutEpisodes = split.holdout.unseal();
  const clusters = new Map<string, BenchEpisode[]>();
  for (const episode of holdoutEpisodes) {
    for (const action of episode.repairs) {
      const list = clusters.get(action) ?? [];
      list.push(episode);
      clusters.set(action, list);
    }
  }

  const holdout: Record<string, Record<string, ClusterMetrics>> = {};
  for (const [action, group] of Array.from(clusters.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    holdout[action] = {};
    for (const candidate of candidates) {
      holdout[action]![candidate.id] = recordedMetrics(candidate, group);
    }
  }

  return {
    ...decision,
    search: {
      seed: search.seed,
      bestId: search.best?.id ?? null,
      bestScore: search.best?.score ?? 0,
      bestAvgLength: search.best?.avgLength ?? 0,
      staticScore: search.staticBaseline.score,
      evaluations: search.evaluations,
    },
    holdout,
    winner: pickWinner(holdout),
    winnerParams: candidates.find((c) => c.id === pickWinner(holdout))?.params,
  };
}

/** Candidate-conditioned holdout scoring through the bounded TASK-0008 runner. */
export async function runTransparencyExperimentWithModel(sources: readonly EpisodeFileInput[], options: ModelExperimentOptions): Promise<ExperimentResult> {
  const base = runTransparencyExperiment(sources, options);
  if (base.decision === "no-go" || !base.holdout) return base;

  const { split } = loadSplit(sources);
  const holdoutEpisodes = split.holdout.unseal();
  const clusters = new Map<string, BenchEpisode[]>();
  for (const episode of holdoutEpisodes) {
    for (const action of episode.repairs) {
      const list = clusters.get(action) ?? [];
      list.push(episode);
      clusters.set(action, list);
    }
  }

  const candidates = experimentCandidates(base.winnerParams ?? null);
  for (const [action, group] of Object.entries(base.holdout)) {
    const groupEpisodes = clusters.get(action) ?? [];
    // Population split keeps each runner call single-population.
    const byKind = new Map<string, BenchEpisode[]>();
    for (const episode of groupEpisodes) {
      const list = byKind.get(episode.kind) ?? [];
      list.push(episode);
      byKind.set(episode.kind, list);
    }
    for (const candidate of candidates) {
      let observed = 0;
      let successes = 0;
      let recurrence = 0;
      let tokens = 0;
      for (const subset of byKind.values()) {
        const result = await runReplayWithModel(subset, candidate, { modelClient: options.modelClient, caps: options.caps });
        observed += result.observed;
        successes += result.successes;
        recurrence += result.byOutcome["repaired-recurrence"] ?? 0;
        tokens += result.tokens;
      }
      base.holdout[action]![candidate.id] = {
        episodes: groupEpisodes.length,
        observed,
        nrr: observed === 0 ? 0 : successes / observed,
        recurrencePerCall: observed === 0 ? 0 : recurrence / observed,
        messageTokens: tokens,
        safetyGates: safetyGatesFor(candidate, groupEpisodes),
      };
    }
  }

  base.winner = pickWinner(base.holdout);
  base.winnerParams = candidates.find((c) => c.id === base.winner)?.params;
  return base;
}
