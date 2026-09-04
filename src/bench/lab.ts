/**
 * Welder Lab — offline message-search spike (TASK-0009, contract v2 §6/§8).
 *
 * Dependency decision (recorded): DO NOT depend on DSPy.ts. Evidence:
 * - Local `.local/dspy.ts` (2.2.1) is unbuilt (no dist/, no node_modules);
 *   installing pulls agentdb, js-pytorch, onnxruntime-web, inversify, pino.
 * - Published `dspy.ts` is 2.2.0 — version drift with local 2.2.1.
 * - Its `LMDriver.generate(prompt): Promise<string>` is text-only: no native
 *   tool-call output. Bridging to Pi/OpenRouter native tool calls needs the
 *   same parse→repairArgs→schema-validate adapter the TASK-0008 bench already
 *   owns — the adapter work dominates, not the optimizer.
 * - `OptimizerConfig` has no timeout, cancellation, cost budget, or cost
 *   accounting; caps would be rebuilt around it anyway.
 * - Its useful deterministic-search idea (seeded RNG over instruction
 *   candidates) is ~10 lines, copied below as `seededRng`.
 *
 * Therefore: bounded deterministic prompt search implemented directly, layered
 * on the TASK-0008 runner (`runReplayWithModel`) which already enforces caps
 * and records tokens/cost. Native tool-call gap: DSPy.ts cannot emit native
 * tool-call responses; this lab therefore evaluates candidates in text-json
 * mode (see `evaluateWithModel`) and labels all such runs non-production-proof.
 *
 * Scope: repair-transparency / factual result-enrichment messaging only.
 * Generic recovery phrasing is structurally ineligible (`validateCandidateMessage`).
 * No Pi runtime dependency; no side-effecting tools; LM is injectable.
 */

import { NO_MESSAGE, SHIPPED, validateCandidateMessage } from "./baselines.ts";
import { runReplayWithModel, type ModelClient, type RunnerCaps } from "./runner.ts";
import type { BenchEpisode } from "./dataset.ts";
import { createOpenRouterClient } from "./smoke.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type { ModelClient, RunnerCaps };
export { validateCandidateMessage };

// --- synthetic task -----------------------------------------------------------

/** Zero-content synthetic trainset: structural metadata only. */
export const SYNTHETIC_TRAINSET: readonly BenchEpisode[] = [
  { episodeId: "lab-1", kind: "repair-warning", sessionId: "lab", toolName: "edit", repairs: ["nest-edit-fields"], inputKeys: ["edits"], outcome: "repaired-recurrence" },
  { episodeId: "lab-2", kind: "repair-warning", sessionId: "lab", toolName: "edit", repairs: ["wrap-array"], inputKeys: ["edits"], outcome: "failed" },
  { episodeId: "lab-3", kind: "repair-warning", sessionId: "lab", toolName: "read", repairs: ["missing-read-context"], inputKeys: ["path"], outcome: "valid" },
  { episodeId: "lab-4", kind: "result-repair", sessionId: "lab", toolName: "read", repairs: ["missing-read-context"], inputKeys: ["path"], outcome: "valid" },
];

export interface TemplateParams {
  header: "hint" | "notice";
  bullet: "dash" | "plain";
  includeKeys: boolean;
  includeWhy: boolean;
}

const WHY_PHRASES: ReadonlyMap<string, string> = new Map([
  ["nest-edit-fields", "so each edit has its own oldText and newText"],
  ["wrap-array", "so the edits field is an array"],
  ["wrap-object-array", "so each edit has its own oldText and newText"],
  ["merge-edit-anchor", "so overlapping edits anchor to one oldText"],
  ["resolve-ambiguous-edit", "so the targeted oldText is unique in the file"],
  ["missing-read-context", "so the retry targets an existing path"],
  ["directory-read", "so directory paths are listed instead of read as files"],
  ["parse-json", "so the command output is valid JSON"],
]);

export function generateTemplateMessage(
  params: TemplateParams,
  episode: Pick<BenchEpisode, "kind" | "repairs"> & { inputKeys?: readonly string[] },
): string {
  const header = params.header === "hint" ? "pi-welder repair hints: recent tool calls were repaired." : "pi-welder notice: deterministic repairs were applied.";
  const lines = episode.repairs.map((action) => {
    const bullet = params.bullet === "dash" ? "- " : "";
    const why = params.includeWhy ? ` ${WHY_PHRASES.get(action) ?? "so the retry succeeds"}` : "";
    const keys = params.includeKeys && episode.inputKeys && episode.inputKeys.length > 0 ? ` (input keys: ${episode.inputKeys.join(", ")})` : "";
    return `${bullet}${action}:${why}${keys}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

/** Welder-style lab metric: eligibility gate, then conciseness tie-break. */
export function scoreMessage(message: string | null, episode: BenchEpisode): { score: number; violation: string | null } {
  const violation = validateCandidateMessage(episode, message);
  if (violation !== null) return { score: 0, violation };
  return { score: 1, violation: null };
}

// --- bounded deterministic search ----------------------------------------------

/** Mulberry32-style seeded RNG (the only idea adopted from DSPy.ts MIPROv2). */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LabCandidate {
  id: string;
  params: TemplateParams;
  score: number;
  avgLength: number;
}

export interface LabSearchOptions {
  seed?: number;
  maxCandidates?: number;
  /** Cancellation hook — checked before every evaluation. */
  shouldStop?: () => boolean;
  /** Injected clock for deterministic timeouts. */
  clock?: { now(): number };
  timeoutMs?: number;
}

export interface LabSearchResult {
  seed: number;
  candidates: LabCandidate[];
  evaluations: number;
  best: LabCandidate | null;
  staticBaseline: LabCandidate;
  calls: number;
  tokens: number;
  costUsd: number;
  stoppedBy: "completed" | "cancelled" | "timeout";
}

function allParamCombinations(): TemplateParams[] {
  const combos: TemplateParams[] = [];
  for (const header of ["hint", "notice"] as const)
    for (const bullet of ["dash", "plain"] as const)
      for (const includeKeys of [false, true])
        for (const includeWhy of [false, true]) combos.push({ header, bullet, includeKeys, includeWhy });
  return combos;
}

function evaluateParams(params: TemplateParams, trainset: readonly BenchEpisode[]): LabCandidate {
  let totalScore = 0;
  let totalLength = 0;
  for (const episode of trainset) {
    const message = generateTemplateMessage(params, episode);
    const { score } = scoreMessage(message, episode);
    totalScore += score;
    totalLength += message.length;
  }
  const n = trainset.length || 1;
  return {
    id: `${params.header}-${params.bullet}-keys:${params.includeKeys}-why:${params.includeWhy}`,
    params,
    score: totalScore / n,
    avgLength: totalLength / n,
  };
}

/** Baselines: B0-equivalent is undefined messaging (ineligible for P1 scoring); static = shipped B1 text. */
export function staticBaseline(trainset: readonly BenchEpisode[]): LabCandidate {
  let totalScore = 0;
  let totalLength = 0;
  for (const episode of trainset) {
    const message = SHIPPED.message(episode);
    const { score } = scoreMessage(message, episode);
    totalScore += message === null ? 0 : score;
    totalLength += message?.length ?? 0;
  }
  const n = trainset.length || 1;
  return { id: "static-baseline:B1-shipped", params: { header: "hint", bullet: "dash", includeKeys: false, includeWhy: false }, score: totalScore / n, avgLength: totalLength / n };
}

export function searchTemplates(trainset: readonly BenchEpisode[], options: LabSearchOptions = {}): LabSearchResult {
  const seed = options.seed ?? 42;
  const maxCandidates = options.maxCandidates ?? 16;
  const clock = options.clock ?? (() => ({ now: () => 0 }))();
  const startedAt = clock.now();

  const rng = seededRng(seed);
  let pool = allParamCombinations();
  // Deterministic seeded shuffle; sample without replacement when bounded.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  pool = pool.slice(0, maxCandidates);

  const result: LabSearchResult = {
    seed,
    candidates: [],
    evaluations: 0,
    best: null,
    staticBaseline: staticBaseline(trainset),
    calls: 0,
    tokens: 0,
    costUsd: 0,
    stoppedBy: "completed",
  };

  for (const params of pool) {
    if (options.shouldStop?.()) {
      result.stoppedBy = "cancelled";
      break;
    }
    if (options.timeoutMs !== undefined && clock.now() - startedAt >= options.timeoutMs) {
      result.stoppedBy = "timeout";
      break;
    }
    const candidate = evaluateParams(params, trainset);
    result.evaluations++;
    result.candidates.push(candidate);
    if (
      candidate.score > (result.best?.score ?? -1) ||
      (candidate.score === result.best?.score && candidate.avgLength < result.best.avgLength)
    ) {
      result.best = candidate;
    }
  }
  return result;
}

// --- LM-conditioned evaluation --------------------------------------------------

export interface LabModelEvaluation {
  score: number;
  observed: number;
  tokens: number;
  calls: number;
  costUsd: number;
  provider: string;
  model: string;
  outputMode: "text-json";
}

/**
 * Conditions the synthetic-task replay on a candidate message via the
 * TASK-0008 runner — caps, tokens, and cost enforced/recorded there.
 */
export async function evaluateWithModel(
  params: TemplateParams,
  trainset: readonly BenchEpisode[],
  client: ModelClient,
  caps: RunnerCaps,
): Promise<LabModelEvaluation> {
  const candidate = {
    id: `template:${params.header}-${params.bullet}-keys:${params.includeKeys}-why:${params.includeWhy}`,
    message: (episode: BenchEpisode) => generateTemplateMessage(params, episode),
  };

  // Populations are evaluated sequentially so the runner's concurrency cap
  // is never doubled; metrics are merged deterministically.
  const groups = new Map<string, BenchEpisode[]>();
  for (const episode of trainset) {
    const population = episode.kind === "repair-warning" ? "P1" : "P2";
    const list = groups.get(population) ?? [];
    list.push(episode);
    groups.set(population, list);
  }

  let successes = 0;
  let observed = 0;
  let tokens = 0;
  let calls = 0;
  let costUsd = 0;
  let provider = "";
  let model = "";
  for (const dataset of groups.values()) {
    const result = await runReplayWithModel(dataset, candidate, { modelClient: client, caps });
    successes += result.successes;
    observed += result.observed;
    tokens += result.tokens;
    calls += result.calls;
    costUsd += result.costUsd;
    provider = provider || result.provider;
    model = model || result.model;
  }

  return {
    score: observed === 0 ? 0 : successes / observed,
    observed,
    tokens,
    calls,
    costUsd,
    provider,
    model,
    outputMode: "text-json",
  };
}

// --- opt-in real-model smoke ------------------------------------------------------

export interface LabSmokeOptions {
  apiKey?: string;
  client?: ModelClient;
  seed?: number;
  maxCandidates?: number;
  caps?: RunnerCaps;
  reportPath?: string;
}

export interface LabSmokeResult {
  ran: boolean;
  reason?: string;
  reportPath?: string;
}

export const DEFAULT_LAB_REPORT = path.resolve(".tmp", "lab-smoke-report.md");

/** Opt-in real-model smoke; without credentials it never runs. Writes ignored artifacts only. */
export async function runLabSmoke(options: LabSmokeOptions = {}): Promise<LabSmokeResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!options.client && !apiKey) return { ran: false, reason: "missing-credentials" };

  const client = options.client ?? createOpenRouterClient(apiKey!);
  const caps: RunnerCaps = options.caps ?? { timeoutMs: 20_000, retryCap: 1, concurrencyCap: 1, costBudgetUsd: 0.1, usdPerToken: 0.0000005 };
  const search = searchTemplates(SYNTHETIC_TRAINSET, { seed: options.seed ?? 42, maxCandidates: options.maxCandidates ?? 4 });
  const bestParams = search.best?.params ?? allParamCombinations()[0]!;
  const evaluation = await evaluateWithModel(bestParams, SYNTHETIC_TRAINSET, client, caps);

  const report = [
    "# welder lab message-search smoke",
    "",
    "Output mode: text-json — DSPy-style text generation cannot emit native tool calls; not production proof (contract v2).",
    "Dependency decision: no DSPy.ts dependency — bounded deterministic search layered on the bench runner.",
    "",
    `seed: ${search.seed} candidates: ${search.candidates.length} stoppedBy: ${search.stoppedBy}`,
    `static-baseline score: ${search.staticBaseline.score.toFixed(3)} avgLength: ${search.staticBaseline.avgLength.toFixed(0)}`,
    `best: ${search.best?.id ?? "none"} score: ${search.best?.score.toFixed(3) ?? "0"} avgLength: ${search.best?.avgLength.toFixed(0) ?? "0"}`,
    `model eval: provider=${evaluation.provider} model=${evaluation.model} score=${evaluation.score.toFixed(3)} tokens=${evaluation.tokens} calls=${evaluation.calls} costUsd=${evaluation.costUsd.toFixed(6)}`,
    `capped: timeoutMs=${caps.timeoutMs} retryCap=${caps.retryCap} concurrencyCap=${caps.concurrencyCap} costBudgetUsd=${caps.costBudgetUsd}`,
    "",
  ].join("\n");

  const reportPath = options.reportPath ?? DEFAULT_LAB_REPORT;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  return { ran: true, reportPath };
}
