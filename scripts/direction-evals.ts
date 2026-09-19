#!/usr/bin/env node
/**
 * TASK-0025 direction evals: run the full offline readout (phase 1 + phase 2
 * fixture counts and offline wiring), with an opt-in real-API Jev probe.
 *
 * Usage (from the pi-welder extension directory):
 *
 *   node --experimental-strip-types scripts/direction-evals.ts report \
 *     [--sessions <dir>] [--out <dir>] [--execute]
 *
 * - Phase 1 (offline, deterministic): bench baselines over recorded episodes
 *   discovered from the session corpus, plus repair-yield over the frozen
 *   instinct fixture suite (dead rules flagged).
 * - Phase 2: probe fixture counts always; the real-API Jev probe runs only
 *   with --execute plus OPENROUTER_API_KEY (opt-in approval convention).
 * - Everything is direction evidence only. Artifacts land under .tmp/ (git-ignored).
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { loadEpisodes, type BenchEpisode } from "../src/bench/dataset.ts";
import { runReplay } from "../src/bench/runner.ts";
import { NO_MESSAGE, SHIPPED } from "../src/bench/baselines.ts";
import { createOpenRouterClient } from "../src/bench/smoke.ts";
import { createModelSelector, ALWAYS_ABSTAIN, evaluateSelector, similarityRankSelector, type SelectionEvalResult } from "../src/bench/edit-selection.ts";
import { INSTINCT_FIXTURES, buildYieldReport, runFixtureSuite } from "../src/bench/instincts.ts";
import { JEV_PROBE_FIXTURES, PROBE_TIERS, probeCasesByTier, probeFixtureCounts } from "../src/bench/probe-fixtures.ts";
import { renderDirectionJson, renderDirectionMarkdown, type BaselineScore, type DirectionReport, type ProbeTierResult } from "../src/bench/direction-report.ts";
import { readEvents } from "../src/recorder/log.ts";

interface Args {
  command: string;
  sessions: string;
  out: string;
  execute: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "report",
    sessions: path.join(homedir(), ".pi", "agent", "sessions"),
    out: path.join(".tmp", "direction-evals"),
    execute: false,
  };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--execute": args.execute = true; break;
      case "--sessions": args.sessions = requireValue(argv, index++); break;
      case "--out": args.out = requireValue(argv, index++); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

function requireValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Flag ${argv[index]} requires a value`);
  return value;
}

// --- phase 1: baselines over recorded episodes ----------------------------------

/** Discovers welder log directories from each transcript's recorded cwd. */
async function discoverLogDirs(sessionsDir: string): Promise<string[]> {
  const discovered = new Set<string>();
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      try {
        const firstLine = (await fs.readFile(path.join(dirPath, file), "utf8")).split("\n", 1)[0] ?? "";
        const cwd = JSON.parse(firstLine)?.cwd;
        if (typeof cwd === "string") discovered.add(path.join(cwd, ".pi", "welder-log"));
      } catch { /* skip unreadable transcripts */ }
    }
  }
  return [...discovered].sort();
}

async function loadRecordedEpisodes(sessionsDir: string): Promise<{ episodes: BenchEpisode[]; rejected: number }> {
  const logDirs = await discoverLogDirs(sessionsDir);
  return collectEpisodes(logDirs);
}

async function collectEpisodes(logDirs: readonly string[]): Promise<{ episodes: BenchEpisode[]; rejected: number }> {
  const episodes: BenchEpisode[] = [];
  let rejected = 0;
  for (const logDir of logDirs) {
    for (const file of (await fs.readdir(logDir).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const filePath = path.join(logDir, file);
      const events = await readEvents(filePath);
      if (events.length === 0) continue;
      const result = loadEpisodes([{ sessionId: path.basename(file, ".jsonl"), events }]);
      episodes.push(...result.episodes);
      rejected += result.rejected.length;
    }
  }
  return { episodes, rejected };
}

function baselineScores(episodes: readonly BenchEpisode[]): BaselineScore[] {
  const scores: BaselineScore[] = [];
  for (const population of ["P1", "P2"] as const) {
    const kind = population === "P1" ? "repair-warning" : "result-repair";
    const dataset = episodes.filter((episode) => episode.kind === kind);
    for (const candidate of [NO_MESSAGE, SHIPPED]) {
      const result = runReplay(dataset, candidate);
      scores.push({
        population,
        episodes: dataset.length,
        candidate: candidate.id,
        score: result.score,
        observed: result.observed,
        successes: result.successes,
        expired: result.expired,
        byOutcome: result.byOutcome,
      });
    }
  }
  return scores;
}

// --- phase 2: probe -------------------------------------------------------------

async function probeTierResults(execute: boolean): Promise<{ executed: boolean; tierResults: ProbeTierResult[] }> {
  const grouped = probeCasesByTier();
  const tierResults: ProbeTierResult[] = [];

  const selectors = execute
    ? [
        { id: "offline-abstain", selector: ALWAYS_ABSTAIN },
        { id: "offline-similarity", selector: similarityRankSelector() },
        { id: "model-ordinal", selector: createModelSelector(createOpenRouterClient(requireApiKey())) },
      ]
    : [
        { id: "offline-abstain", selector: ALWAYS_ABSTAIN },
        { id: "offline-similarity", selector: similarityRankSelector() },
      ];

  for (const group of grouped) {
    for (const entry of selectors) {
      const result: SelectionEvalResult = await evaluateSelector(group.cases, entry.selector);
      tierResults.push({
        tier: group.tier,
        fixtures: group.cases.length,
        selectorId: entry.id,
        selected: result.selected,
        correct: result.correct,
        wrong: result.wrong,
        abstained: result.abstained,
        abstentionRate: result.abstentionRate,
        precision: result.precision,
      });
    }
  }
  return { executed: execute, tierResults };
}

function requireApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("--execute requires OPENROUTER_API_KEY");
  return apiKey;
}

// --- report ---------------------------------------------------------------------

async function commandReport(args: Args): Promise<void> {
  const recorded = await loadRecordedEpisodes(args.sessions);
  const baselines = baselineScores(recorded.episodes);

  const fixtureRoot = path.join(args.out, "fixture-root");
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  const runs = await runFixtureSuite(INSTINCT_FIXTURES, fixtureRoot);
  const yieldReport = buildYieldReport(INSTINCT_FIXTURES, runs);

  const counts = probeFixtureCounts();
  const probe = await probeTierResults(args.execute);

  const report: DirectionReport = {
    label: "direction evidence only",
    baselines,
    yield: yieldReport,
    probe: {
      totalFixtures: JEV_PROBE_FIXTURES.length,
      tiers: PROBE_TIERS.map((tier) => ({ tier, fixtures: counts[tier] })),
      executed: probe.executed,
      tierResults: probe.tierResults,
    },
  };

  await fs.mkdir(args.out, { recursive: true });
  const markdown = renderDirectionMarkdown(report);
  await fs.writeFile(path.join(args.out, "report.md"), markdown);
  await fs.writeFile(path.join(args.out, "report.json"), renderDirectionJson(report));
  process.stdout.write(markdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "report") await commandReport(args);
else throw new Error(`Unknown command ${args.command} (use: report)`);
