#!/usr/bin/env node
/**
 * TASK-0036 — schema-driven tool/field mapping evaluation.
 *
 * Mines strict Pi validation failures, plans bounded `{target tool, mapping}`
 * hypotheses (no alias list), labels from a bounded later call that matches a
 * plan exactly, and runs jeq only when >=30 labelable cases exist and the
 * request privacy gate passes. Shadow-only: nothing executes or mutates.
 *
 * Usage: node --experimental-strip-types scripts/tool-mapping-eval.ts run [--sessions d] [--out d] [--budget n] [--no-jeq]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { planMappings, type MappingPlan } from "../src/tool-mapping/planner.ts";
import {
  MAPPING_PROMOTION_GATE,
  buildToolMappingRequest,
  decideMappings,
  evaluateMappings,
  parseToolMappingAnswer,
  planOptions,
  type LabelledPlanCase,
  type MappingOutcome,
} from "../src/tool-mapping/evaluation.ts";
import { extractPlanEpisodes, type MappingEvent } from "../src/tool-mapping/episode.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_OUT = ".tmp/tool-mapping-eval";
const MIN_LABELABLE = 30;

interface Args { command: string; sessions: string; out: string; budget: number; jeq: boolean }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", sessions: DEFAULT_SESSIONS, out: DEFAULT_OUT, budget: 200, jeq: true };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--sessions": args.sessions = argv[++index] ?? args.sessions; break;
      case "--out": args.out = argv[++index] ?? args.out; break;
      case "--budget": args.budget = Number(argv[++index] ?? args.budget); break;
      case "--no-jeq": args.jeq = false; break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

function parseSessionText(text: string): { sessionId: string; events: MappingEvent[] } {
  let sessionId = "";
  const events: MappingEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session") { if (typeof entry.id === "string") sessionId = entry.id; continue; }
    const message = entry.message;
    if (!message || typeof entry.timestamp !== "string") continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const args = block.arguments;
        events.push({
          id: block.id, ts: entry.timestamp, kind: "toolCall",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolCallId: block.id,
          args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        });
      }
      continue;
    }
    if (message.role === "user") {
      if (textOf(message.content)) events.push({ id: `${entry.id ?? events.length}`, ts: entry.timestamp, kind: "user" });
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const content = textOf(message.content);
      events.push({
        id: message.toolCallId, ts: entry.timestamp, kind: "toolResult",
        toolCallId: message.toolCallId,
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        ...(content ? { errorText: content } : {}),
      });
    }
  }
  return { sessionId, events };
}

/** Privacy gate: closed keys/roles/features/ordinals only; no raw values. */
export function mappingRequestPrivacyPasses(requests: readonly string[]): boolean {
  const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;
  const shapes = new Set(["path", "prose", "code", "shell", "collection", "numeric", "boolean", "value"]);
  const kinds = new Set(["string", "number", "boolean", "array"]);
  const buckets = new Set(["empty", "short", "medium", "long", "huge", "zero", "one", "few", "several", "many"]);
  return requests.every((request) => {
    let parsed: any;
    try { parsed = JSON.parse(request); } catch { return false; }
    if (!parsed || Object.keys(parsed).sort().join(",") !== "model,prompt,questions,state") return false;
    if (typeof parsed.model !== "string" || typeof parsed.prompt !== "string" || parsed.prompt.length > 400) return false;
    const state = parsed.state;
    if (!state || Object.keys(state).sort().join(",") !== "attemptedTool,failureClass,plans,prior,targets") return false;
    if (state.failureClass !== "schema-validation") return false;
    if (typeof state.attemptedTool !== "string" || !identifier.test(state.attemptedTool)) return false;
    if (!Array.isArray(state.targets) || state.targets.some((target: unknown) => typeof target !== "string" || !identifier.test(target))) return false;
    if (!Array.isArray(state.plans)) return false;
    for (const plan of state.plans) {
      if (!plan || Object.keys(plan).sort().join(",") !== "fields,ordinal,targetTool") return false;
      if (typeof plan.ordinal !== "number" || typeof plan.targetTool !== "string" || !identifier.test(plan.targetTool)) return false;
      if (!Array.isArray(plan.fields)) return false;
      for (const field of plan.fields) {
        if (!field || Object.keys(field).sort().join(",") !== "features,from,role") return false;
        if (typeof field.from !== "string" || !identifier.test(field.from)) return false;
        if (typeof field.role !== "string" || !identifier.test(field.role)) return false;
        const features = field.features;
        if (!features) return false;
        const featureKeys = Object.keys(features);
        const requiredFeatureKeys = ["itemBucket", "kind", "lengthBucket", "shape", "tokenBucket"];
        const baseFeatureKeys = ["kind", "lengthBucket", "shape", "tokenBucket"];
        const actualKeys = featureKeys.sort().join(",");
        if (actualKeys !== requiredFeatureKeys.join(",") && actualKeys !== baseFeatureKeys.join(",")) return false;
        if (!kinds.has(features.kind) || !shapes.has(features.shape)) return false;
        if (!buckets.has(features.lengthBucket) || !buckets.has(features.tokenBucket)) return false;
        if (features.itemBucket !== undefined && !buckets.has(features.itemBucket)) return false;
      }
    }
    const prior = state.prior;
    if (!prior || Object.keys(prior).sort().join(",") !== "priorFailedCalls,priorToolNames") return false;
    if (!Array.isArray(prior.priorToolNames) || prior.priorToolNames.some((name: unknown) => typeof name !== "string" || !identifier.test(name))) return false;
    if (!Number.isInteger(prior.priorFailedCalls)) return false;
    const criteria = parsed.questions?.plan?.criteria;
    if (!criteria || typeof criteria !== "object") return false;
    const expected = [...state.plans.map((plan: any) => `plan-${plan.ordinal}`), "none"].sort();
    if (Object.keys(criteria).sort().join(",") !== expected.join(",")) return false;
    return Object.values(criteria).every((value) => typeof value === "string" && value.length <= 200);
  });
}

/** Deterministic baseline: maximum identity overlap (`from === role`), then ordinal. */
export function baselineIdentityOverlapOrdinal(plans: readonly MappingPlan[]): number | undefined {
  let best: { ordinal: number; score: number } | undefined;
  for (const plan of plans) {
    const score = plan.pairs.filter((pair) => pair.from === pair.to).length;
    if (best === undefined || score > best.score || (score === best.score && plan.ordinal < best.ordinal)) best = { ordinal: plan.ordinal, score };
  }
  return best?.ordinal;
}

interface Episode { episodeId: string; sessionId: string; sourceTool: string; plans: MappingPlan[]; canonicalTimeout?: boolean; labelPlanOrdinal?: number; targetTool?: string }

async function collect(sessionsDir: string): Promise<{ sessions: number; attrition: Record<string, unknown>; episodes: Episode[]; corpus: any }> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const total: Record<string, unknown> = { mined: 0, planned: 0, abstained: 0, labelled: 0, noLaterCall: 0, abstainReasons: {} as Record<string, number> };
  const episodes: Episode[] = [];
  const fingerprint: { file: string; size: number; mtimeMs: number }[] = [];
  let sessions = 0;

  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const fullPath = path.join(dirPath, file);
      const stat = await fs.stat(fullPath).catch(() => undefined);
      if (stat === undefined) continue;
      fingerprint.push({ file: path.relative(sessionsDir, fullPath), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      const text = await fs.readFile(fullPath, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const session = parseSessionText(text);
      if (!session.sessionId) continue;
      sessions++;
      const { episodes: mined, attrition } = extractPlanEpisodes(session.sessionId, session.events);
      for (const key of Object.keys(total)) {
        if (key === "abstainReasons") {
          const reasons = total.abstainReasons as Record<string, number>;
          for (const [reason, count] of Object.entries(attrition.abstainReasons)) reasons[reason] = (reasons[reason] ?? 0) + count;
          continue;
        }
        total[key] = (total[key] as number) + ((attrition as unknown as Record<string, number>)[key] ?? 0);
      }
      episodes.push(...mined);
    }
  }

  fingerprint.sort((a, b) => a.file.localeCompare(b.file));
  const digest = createHash("sha256");
  for (const entry of fingerprint) digest.update(`${entry.file}\0${entry.size}\0${entry.mtimeMs}\n`);
  return {
    sessions,
    attrition: total,
    episodes,
    corpus: {
      root: sessionsDir.startsWith(homedir()) ? `~${sessionsDir.slice(homedir().length)}` : path.basename(sessionsDir),
      algorithm: "sha256(relativePath\\0size\\0mtimeMs)",
      files: fingerprint.length,
      bytes: fingerprint.reduce((sum, entry) => sum + entry.size, 0),
      hash: digest.digest("hex"),
    },
  };
}

async function runJeq(cases: readonly Episode[], outDir: string, budget: number): Promise<{ results: MappingOutcome[]; audit: any[] }> {
  const requestDir = path.join(outDir, "requests");
  await fs.mkdir(requestDir, { recursive: true });
  const results: MappingOutcome[] = [];
  const audit: any[] = [];

  for (const [index, episode] of cases.slice(0, budget).entries()) {
    const options = planOptions(episode.plans.length);
    const request = buildToolMappingRequest(episode.sourceTool, episode.plans, episode.plans[0] === undefined ? {} : Object.fromEntries(episode.plans.flatMap((plan) => plan.pairs.map((pair) => [pair.from, plan.args[pair.to]]))));
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}.json`);
    await fs.writeFile(requestFile, JSON.stringify(request));
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
      const parsed = parseToolMappingAnswer(stdout, options);
      const latencyMs = Date.now() - started;
      if (!parsed) {
        results.push({ caseId: episode.episodeId, sessionId: episode.sessionId, status: "malformed", latencyMs });
        audit.push({ caseId: episode.episodeId, sessionId: episode.sessionId, expectedPlanOrdinal: episode.labelPlanOrdinal, status: "malformed", latencyMs });
        continue;
      }
      const status = parsed.planOrdinal === null ? "abstained" as const : "answered" as const;
      results.push({ caseId: episode.episodeId, sessionId: episode.sessionId, status, ...(parsed.planOrdinal === null ? {} : { planOrdinal: parsed.planOrdinal }), ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }), latencyMs });
      audit.push({
        caseId: episode.episodeId, sessionId: episode.sessionId, expectedPlanOrdinal: episode.labelPlanOrdinal,
        plans: episode.plans.map((plan) => ({ ordinal: plan.ordinal, targetTool: plan.targetTool, pairs: plan.pairs })),
        status, ...(parsed.planOrdinal === null ? {} : { planOrdinal: parsed.planOrdinal }), ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }), probabilities: parsed.probabilities, latencyMs,
      });
    } catch {
      const latencyMs = Date.now() - started;
      results.push({ caseId: episode.episodeId, sessionId: episode.sessionId, status: "failed", latencyMs });
      audit.push({ caseId: episode.episodeId, sessionId: episode.sessionId, expectedPlanOrdinal: episode.labelPlanOrdinal, status: "failed", latencyMs });
    }
  }
  await fs.writeFile(path.join(outDir, "audit.jsonl"), audit.map((record) => JSON.stringify(record)).join("\n") + (audit.length ? "\n" : ""));
  return { results, audit };
}

async function commandRun(args: Args): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const { sessions, attrition, episodes, corpus } = await collect(args.sessions);

  const labelable = episodes.filter((episode) => episode.labelPlanOrdinal !== undefined);
  const labelled: LabelledPlanCase[] = labelable.map((episode) => ({
    caseId: episode.episodeId,
    sessionId: episode.sessionId,
    labelPlanOrdinal: episode.labelPlanOrdinal!,
    planCount: episode.plans.length,
    sourceTool: episode.sourceTool,
    targetTool: episode.targetTool!,
    baselineFirstPlan: episode.plans[0]!.ordinal,
    baselineIdentityOverlap: baselineIdentityOverlapOrdinal(episode.plans),
  }));

  const requests = labelable.map((episode) => {
    const values: Record<string, unknown> = {};
    for (const plan of episode.plans) for (const pair of plan.pairs) values[pair.from] = plan.args[pair.to];
    return JSON.stringify(buildToolMappingRequest(episode.sourceTool, episode.plans, values));
  });
  const privacyPass = mappingRequestPrivacyPasses(requests);
  const coverage = (attrition.mined as number) === 0 ? 0 : (attrition.planned as number) / (attrition.mined as number);
  const planCounts = episodes.reduce<Record<string, number>>((counts, episode) => {
    const key = String(episode.plans.length);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const report: Record<string, unknown> = {
    label: "direction evidence only — shadow measurement, nothing executes",
    sessions, attrition, episodes: episodes.length, labelable: labelable.length,
    candidateSetCoverage: coverage, planCounts,
    requestPrivacyPass: privacyPass,
    corpus: { root: corpus.root, algorithm: corpus.algorithm, files: corpus.files, bytes: corpus.bytes, hash: corpus.hash },
    gate: MAPPING_PROMOTION_GATE,
  };

  const shouldRun = args.jeq && privacyPass && labelable.length >= MIN_LABELABLE;
  if (shouldRun) {
    const { results } = await runJeq(labelable, args.out, args.budget);
    const metrics = evaluateMappings(labelled, results);
    report.metrics = metrics;
    report.verdict = decideMappings(coverage, metrics, labelable.length);
    report.evaluated = results.length;
  } else {
    report.evaluated = 0;
    report.verdict = !privacyPass
      ? { verdict: "reject", reason: "request-privacy-tests-failed" }
      : { verdict: "reject", reason: `insufficient-labelable-cases: ${labelable.length} < ${MIN_LABELABLE}` };
  }
  report.run = { startedAt, durationMs: Date.now() - startedMs, budget: args.budget, retries: 0, jeq: JEQ_BIN, jeqRan: shouldRun };

  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(args.out, "snapshot.json"), JSON.stringify(corpus, null, 2) + "\n");
  console.log(JSON.stringify({ sessions, attrition, labelable: labelable.length, planCounts, candidateSetCoverage: coverage, requestPrivacyPass: privacyPass, corpusHash: corpus.hash, verdict: report.verdict, run: report.run }, null, 1));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
