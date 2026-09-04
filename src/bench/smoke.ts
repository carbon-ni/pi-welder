/**
 * Bounded real-model smoke run for the replay benchmark (TASK-0008).
 *
 * Opt-in: requires an API key (OPENROUTER_API_KEY or opts.apiKey) or an
 * injected client for tests. Writes a local git-ignored report. Never called
 * by `npm test`; tests use injected fake clients and stay deterministic.
 *
 * Run manually:
 *   OPENROUTER_API_KEY=... node --experimental-strip-types src/bench/smoke.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runReplayWithModel, type ModelClient, type RunnerCaps } from "./runner.ts";
import { NO_MESSAGE, SHIPPED } from "./baselines.ts";
import { loadEpisodes, type BenchEpisode } from "./dataset.ts";
import { readEvents, listSessionLogs } from "../recorder/log.ts";

export const DEFAULT_SMOKE_REPORT = path.resolve(".tmp", "bench-smoke-report.md");
export const DEFAULT_SMOKE_MODEL = "google/gemini-2.5-flash";
const DEFAULT_SMOKE_CAPS: RunnerCaps = {
  timeoutMs: 30_000,
  retryCap: 2,
  concurrencyCap: 2,
  costBudgetUsd: 0.5,
  usdPerToken: 0.0000005,
};

export function createOpenRouterClient(apiKey: string, model = DEFAULT_SMOKE_MODEL, timeoutMs = 30_000): ModelClient {
  if (!apiKey) throw new Error("openrouter client requires an api key");
  return {
    async complete(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: request.messages, temperature: 0 }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`openrouter ${response.status}`);
        const body = await response.json() as {
          choices?: { message?: { content?: string } }[];
          usage?: { total_tokens?: number };
          model?: string;
        };
        const content = body.choices?.[0]?.message?.content ?? "";
        if (!content) throw new Error("openrouter empty content");
        return {
          content,
          tokens: body.usage?.total_tokens ?? 0,
          latencyMs: 0,
          provider: "openrouter",
          model: body.model ?? model,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface SmokeOptions {
  apiKey?: string;
  client?: ModelClient;
  /** Precomputed dataset; defaults to welding local `.pi/welder-log` episodes. */
  dataset?: readonly BenchEpisode[];
  caps?: RunnerCaps;
  reportPath?: string;
  logDir?: string;
}

export interface SmokeResult {
  ran: boolean;
  reason?: string;
  reportPath?: string;
}

export async function runSmoke(options: SmokeOptions = {}): Promise<SmokeResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!options.client && !apiKey) return { ran: false, reason: "missing-credentials" };

  const client = options.client ?? createOpenRouterClient(apiKey!);
  const dataset = options.dataset ?? await loadLocalEpisodes(options.logDir ?? path.resolve(".pi", "welder-log"));
  const caps = options.caps ?? DEFAULT_SMOKE_CAPS;
  const reportPath = options.reportPath ?? DEFAULT_SMOKE_REPORT;

  const b0 = await runReplayWithModel(dataset, NO_MESSAGE, { modelClient: client, caps });
  const b1 = await runReplayWithModel(dataset, SHIPPED, { modelClient: client, caps });

  const report = [
    "# welder replay benchmark smoke",
    "",
    "Output mode: text-json — label distribution may differ from native tool calls; not production proof (contract v2).",
    "",
    `caps: timeoutMs=${caps.timeoutMs} retryCap=${caps.retryCap} concurrencyCap=${caps.concurrencyCap} costBudgetUsd=${caps.costBudgetUsd}`,
    `client: provider=${b1.provider || "unknown"} model=${b1.model || "unknown"} errorClass=${b1.errorClass}`,
    "",
    `## ${b0.candidateId}`,
    `episodes: ${b0.total} observed: ${b0.observed} score: ${b0.score.toFixed(3)} tokens: ${b0.tokens} calls: ${b0.calls}`,
    "",
    `## ${b1.candidateId}`,
    `episodes: ${b1.total} observed: ${b1.observed} score: ${b1.score.toFixed(3)} tokens: ${b1.tokens} calls: ${b1.calls}`,
    "",
    "Note: smoke runs are bounded sanity checks, not adoption evidence (contract v2 §9/§10).",
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  return { ran: true, reportPath };
}

/** Load closed episode records from a welder log directory. */
export async function loadLocalEpisodes(logDir: string): Promise<BenchEpisode[]> {
  const files = await listSessionLogs(logDir);
  const sources = [] as { sessionId: string; events: Record<string, unknown>[] }[];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    sources.push({ sessionId, events: await readEvents(path.join(logDir, file)) as unknown as Record<string, unknown>[] });
  }
  return loadEpisodes(sources).episodes;
}

// CLI entry — runs only when executed directly, never on import.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSmoke().then((result) => {
    if (!result.ran) {
      console.error(`smoke skipped: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`smoke report written: ${result.reportPath}`);
  }).catch((error) => {
    console.error(`smoke failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
