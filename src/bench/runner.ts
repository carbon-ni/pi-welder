/**
 * Deterministic offline replay runner (contract v2 §6, TASK-0008).
 *
 * `runReplay` (sync, no model) reproduces recorded episode outcomes for the
 * baselines — a benchmark that cannot reproduce baseline behavior is invalid.
 *
 * `runReplayWithModel` (async) conditions the replayed retry on a candidate
 * message via an injected model client; the client is fully injectable and
 * mocked in tests — no live filesystem, shell, or network here.
 *
 * Hard guards:
 * - sealed (redacted) episodes cannot be scored;
 * - model runs require bounded caps (timeout, retry, concurrency, cost);
 * - candidates emitting messages for repair-free episodes are disqualified;
 * - generic/ineligible messages fail validation and earn no credit.
 */

import { repairArgs } from "../repairs/index.ts";
import { schemaForTool, validateAgainstSchema } from "../schemas.ts";
import { validateCandidateMessage, type BenchCandidate } from "./baselines.ts";
import type { BenchEpisode } from "./dataset.ts";

export interface ModelClientRequest {
  toolName: string;
  messages: readonly { role: string; content: string }[];
}

export interface ModelClientResponse {
  content: string;
  tokens: number;
  latencyMs: number;
  provider?: string;
  model?: string;
}

export interface ModelClient {
  complete(request: ModelClientRequest): Promise<ModelClientResponse>;
}

export interface RunnerCaps {
  timeoutMs: number;
  retryCap: number;
  concurrencyCap: number;
  costBudgetUsd: number;
  usdPerToken?: number;
}

export interface BenchFailure {
  episodeId: string;
  reason: string;
}

export type Population = "P1" | "P2";

export interface BenchRunResult {
  candidateId: string;
  population: Population;
  outputMode: "text-json" | "native";
  total: number;
  observed: number;
  expired: number;
  successes: number;
  score: number;
  byOutcome: Record<string, number>;
  repairs: number;
  calls: number;
  retries: number;
  tokens: number;
  latencyMs: number;
  costUsd: number;
  provider: string;
  model: string;
  errorClass: "none" | "client-error" | "budget-exceeded";
  disqualifications: string[];
  failures: BenchFailure[];
}

export interface ReplayOptions {
  outputMode?: "text-json" | "native";
}

export interface ModelReplayOptions extends ReplayOptions {
  modelClient: ModelClient;
  caps: RunnerCaps;
}

function emptyResult(candidate: BenchCandidate, population: Population, outputMode: "text-json" | "native"): BenchRunResult {
  return {
    candidateId: candidate.id,
    population,
    outputMode,
    total: 0,
    observed: 0,
    expired: 0,
    successes: 0,
    score: 0,
    byOutcome: {},
    repairs: 0,
    calls: 0,
    retries: 0,
    tokens: 0,
    latencyMs: 0,
    costUsd: 0,
    provider: "",
    model: "",
    errorClass: "none",
    disqualifications: [],
    failures: [],
  };
}

function checkDataset(dataset: readonly BenchEpisode[]): Population {
  for (const episode of dataset) {
    if (!episode.outcome) throw new Error("sealed holdout: unseal before scoring");
  }
  const populations = new Set(dataset.map((episode) => (episode.kind === "repair-warning" ? "P1" : "P2")));
  if (populations.size > 1) throw new Error("mixed-population dataset: run one population at a time");
  return populations.has("P1") ? "P1" : "P2";
}

function recordOutcome(result: BenchRunResult, outcome: string, successOf: (outcome: string) => boolean): void {
  result.byOutcome[outcome] = (result.byOutcome[outcome] ?? 0) + 1;
  if (outcome.startsWith("repaired")) result.repairs++;
  if (outcome === "expired") {
    result.expired++;
    return;
  }
  result.observed++;
  if (successOf(outcome)) result.successes++;
}

const OUTCOME_SUCCESS: Record<Population, (outcome: string) => boolean> = {
  // P1 (repair warnings): NRR — the same repair must not recur.
  P1: (outcome) => outcome !== "repaired-recurrence",
  // P2 (result enrichment): FRV — the first retry must be valid.
  P2: (outcome) => outcome === "valid",
};

/** Baseline reproduction: score recorded outcomes as-is. Deterministic. */
export function runReplay(dataset: readonly BenchEpisode[], candidate: BenchCandidate, options: ReplayOptions = {}): BenchRunResult {
  const population = checkDataset(dataset);
  const result = emptyResult(candidate, population, options.outputMode ?? "native");
  result.total = dataset.length;
  const successOf = OUTCOME_SUCCESS[population];
  for (const episode of dataset) {
    recordOutcome(result, episode.outcome, successOf);
  }
  result.score = result.observed === 0 ? 0 : result.successes / result.observed;
  return result;
}

/** Candidate-conditioned replay through an injected, bounded model client. */
export async function runReplayWithModel(
  dataset: readonly BenchEpisode[],
  candidate: BenchCandidate,
  options: ModelReplayOptions,
): Promise<BenchRunResult> {
  const population = checkDataset(dataset);
  requireCaps(options.caps);
  const result = emptyResult(candidate, population, options.outputMode ?? "text-json");
  result.total = dataset.length;
  const successOf = OUTCOME_SUCCESS[population];
  const usdPerToken = options.caps.usdPerToken ?? 0;
  let budgetExceeded = false;

  const replayOne = async (episode: BenchEpisode): Promise<void> => {
    if (budgetExceeded) {
      result.failures.push({ episodeId: episode.episodeId, reason: "budget-exceeded" });
      return;
    }
    let outcome: string = episode.outcome;
    const message = candidate.message(episode);

    if (message !== null && episode.repairs.length === 0) {
      result.disqualifications.push(`${candidate.id}:message-for-repair-free-episode:${episode.episodeId}`);
      result.failures.push({ episodeId: episode.episodeId, reason: "disqualified" });
      outcome = "failed";
    } else if (message !== null) {
      const violation = validateCandidateMessage(episode, message);
      if (violation) {
        result.failures.push({ episodeId: episode.episodeId, reason: violation });
        outcome = "failed";
      } else {
        const replayed = await callModel(episode, message, result, options, usdPerToken);
        if (replayed === "budget-exceeded") {
          budgetExceeded = true;
        }
        outcome = replayed;
      }
    }
    // message === null keeps the recorded outcome: no-message replay is the
    // recorded session reality, not a new simulation.

    recordOutcome(result, outcome, successOf);
  };

  // Deterministic, order-preserving bounded concurrency: fixed-size chunks.
  const cap = Math.max(1, Math.min(options.caps.concurrencyCap, dataset.length));
  for (let i = 0; i < dataset.length; i += cap) {
    await Promise.all(dataset.slice(i, i + cap).map(replayOne));
    if (budgetExceeded) {
      for (const episode of dataset.slice(i + cap)) {
        result.failures.push({ episodeId: episode.episodeId, reason: "budget-exceeded" });
      }
      break;
    }
  }

  result.score = result.observed === 0 ? 0 : result.successes / result.observed;
  return result;
}

async function callModel(
  episode: BenchEpisode,
  message: string,
  result: BenchRunResult,
  options: ModelReplayOptions,
  usdPerToken: number,
): Promise<string> {
  const caps = options.caps;
  const maxAttempts = 1 + caps.retryCap;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.calls++;
    try {
      const response = await options.modelClient.complete({
        toolName: episode.toolName,
        messages: [
          { role: "system", content: message },
          { role: "user", content: `Retry the ${episode.toolName} tool call with valid arguments. Reply with only the JSON arguments.` },
        ],
      });
      result.tokens += response.tokens;
      result.latencyMs += response.latencyMs;
      result.costUsd += response.tokens * usdPerToken;
      result.provider = response.provider ?? result.provider;
      result.model = response.model ?? result.model;
      if (result.costUsd > caps.costBudgetUsd) {
        result.errorClass = "budget-exceeded";
        result.failures.push({ episodeId: episode.episodeId, reason: "budget-exceeded" });
        return "budget-exceeded";
      }
      return modelOutcome(episode, response.content, result);
    } catch (error) {
      if (attempt <= caps.retryCap) {
        result.retries++;
        continue;
      }
      result.errorClass = "client-error";
      result.failures.push({ episodeId: episode.episodeId, reason: `client-error:${(error as Error).message}` });
      return "failed";
    }
  }
  return "failed";
}

function modelOutcome(episode: BenchEpisode, content: string, result: BenchRunResult): string {
  let args: unknown;
  try {
    args = JSON.parse(content);
  } catch {
    result.failures.push({ episodeId: episode.episodeId, reason: "unparseable-retry" });
    return "failed";
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    result.failures.push({ episodeId: episode.episodeId, reason: "unparseable-retry" });
    return "failed";
  }

  const repair = repairArgs(args as Record<string, unknown>, { toolName: episode.toolName });
  const actions = repair.repairs.map((r) => r.action);
  if (actions.length > 0) {
    return actions.some((action) => episode.repairs.includes(action)) ? "repaired-recurrence" : "repaired-other";
  }

  const schema = schemaForTool(episode.toolName);
  const issues = schema ? validateAgainstSchema(repair.result, schema) : [];
  if (issues.length > 0 || repair.validation?.rejected) {
    result.failures.push({ episodeId: episode.episodeId, reason: "schema-invalid-retry" });
    return "failed";
  }
  return "valid";
}

function requireCaps(caps: RunnerCaps): void {
  if (!(caps.timeoutMs > 0)) throw new Error("caps.timeoutMs must be positive");
  if (!(caps.retryCap >= 0)) throw new Error("caps.retryCap must be >= 0");
  if (!(caps.concurrencyCap >= 1)) throw new Error("caps.concurrencyCap must be >= 1");
  if (!(caps.costBudgetUsd > 0)) throw new Error("caps.costBudgetUsd must be positive");
}
