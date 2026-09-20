#!/usr/bin/env node
/**
 * TASK-0032 — non-unique edit occurrence evaluation.
 *
 * Offline: mine 2–5-occurrence edit failures, reconstruct the source snapshot
 * from a following same-path read (no user/mutation first), build minimal
 * unique candidates, label from the later successful edit. jeq runs ONLY when
 * >= 30 labelable cases AND request privacy passes. No runtime integration.
 *
 * Usage:
 *   node --experimental-strip-types scripts/occurrence-eval.ts run [--sessions <dir>] [--out <dir>] [--budget <n>] [--no-jeq]
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { buildOccurrenceCandidates, occurrenceOffsets, type OccurrenceCandidate } from "../src/occurrence/source.ts";
import { extractOccurrenceEpisodes, positionBucketFor, type OccurrenceEpisode, type OccurrenceEvent } from "../src/occurrence/episode.ts";
import {
  OCCURRENCE_PROMOTION_GATE,
  buildOccurrenceRequest,
  decideOccurrences,
  evaluateOccurrences,
  occurrenceOptions,
  parseOccurrenceResponse,
  readDistanceBucketOf,
  type LabelableCase,
  type OccurrenceFeatures,
  type OccurrenceResult,
} from "../src/occurrence/evaluation.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_OUT = ".tmp/occurrence-eval";
const DEFAULT_BUDGET = 60;
const MIN_LABELABLE = 30;

interface Args { command: string; sessions: string; out: string; budget: number; jeq: boolean }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", sessions: DEFAULT_SESSIONS, out: DEFAULT_OUT, budget: DEFAULT_BUDGET, jeq: true };
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

function parseSessionText(text: string): { sessionId: string; events: OccurrenceEvent[] } {
  let sessionId = "";
  const events: OccurrenceEvent[] = [];
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
        const input = (block.arguments ?? {}) as Record<string, unknown>;
        const firstEdit = Array.isArray(input.edits) ? (input.edits[0] as Record<string, unknown> | undefined) : undefined;
        events.push({
          id: block.id,
          ts: entry.timestamp,
          kind: "toolCall",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolCallId: block.id,
          ...(typeof input.path === "string" ? { path: input.path } : {}),
          ...(typeof firstEdit?.oldText === "string" ? { oldText: firstEdit.oldText } : {}),
          ...(typeof firstEdit?.newText === "string" ? { newText: firstEdit.newText } : {}),
          ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        });
      }
      continue;
    }
    if (message.role === "user") { const content = textOf(message.content); if (content) events.push({ id: `${entry.id ?? events.length}`, ts: entry.timestamp, kind: "user" }); continue; }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const content = textOf(message.content);
      events.push({
        id: message.toolCallId,
        ts: entry.timestamp,
        kind: "toolResult",
        toolCallId: message.toolCallId,
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        ...(content ? { errorText: content, content } : {}),
      });
    }
  }
  return { sessionId, events };
}

/** Line number (1-based) of a character offset. */
function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** Nearest-read baseline: occurrence closest to the prior read's line window. */
function nearestReadBaseline(episode: OccurrenceEpisode, candidates: readonly OccurrenceCandidate[]): number | undefined {
  if (episode.priorReadOffset === undefined) return undefined;
  const start = episode.priorReadOffset;
  const end = start + (episode.priorReadLimit ?? 1) - 1;
  let best: { ordinal: number; distance: number } | undefined;
  for (const candidate of candidates) {
    const line = lineAt(episode.source, candidate.startOffset);
    const distance = line < start ? start - line : line > end ? line - end : 0;
    if (!best || distance < best.distance) best = { ordinal: candidate.ordinal, distance };
  }
  return best?.ordinal;
}

function featuresFor(episode: OccurrenceEpisode, candidates: readonly OccurrenceCandidate[]): OccurrenceFeatures[] {
  return candidates.map((candidate) => {
    const readLine = episode.priorReadOffset === undefined ? undefined : lineAt(episode.source, candidate.startOffset);
    const distance = readLine === undefined || episode.priorReadOffset === undefined
      ? undefined
      : Math.abs(readLine - episode.priorReadOffset);
    return {
      ordinal: candidate.ordinal,
      position: positionBucketFor(candidate.ordinal, candidates.length),
      readRelation: episode.priorReadOffset === undefined ? "none" : "before",
      readDistance: readDistanceBucketOf(distance),
      contextLength: candidate.contextBucket,
    };
  });
}

interface PreparedCase { episode: OccurrenceEpisode; candidates: OccurrenceCandidate[]; features: OccurrenceFeatures[]; options: string[]; request: string; baselineNearest?: number }

async function collect(sessionsDir: string): Promise<{ sessions: number; attrition: Record<string, number>; cases: PreparedCase[] }> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  let sessions = 0;
  const total = { mined: 0, occurrencesEligible: 0, sourceReconstructed: 0, candidatesBuilt: 0, locatorExtensions: 0, labelable: 0 };
  const cases: PreparedCase[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const text = await fs.readFile(path.join(dirPath, file), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const session = parseSessionText(text);
      if (!session.sessionId) continue;
      sessions++;
      const { episodes, attrition } = extractOccurrenceEpisodes(session.sessionId, session.events);
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += attrition[key];
      for (const episode of episodes) {
        const candidates = buildOccurrenceCandidates(episode.source, episode.anchor, episode.replacement);
        if (candidates.length < 2 || candidates.some((candidate) => !candidate.unique)) continue;
        const features = featuresFor(episode, candidates);
        const baselineNearest = nearestReadBaseline(episode, candidates);
        cases.push({
          episode,
          candidates,
          features,
          options: occurrenceOptions(candidates),
          request: JSON.stringify(buildOccurrenceRequest(episode, features)),
          ...(baselineNearest === undefined ? {} : { baselineNearest }),
        });
      }
    }
  }
  return { sessions, attrition: total, cases };
}

/** Request privacy gate: closed features only. */
export function occurrenceRequestPrivacyPasses(requests: readonly string[]): boolean {
  const forbidden = [/\/Users\//, /\/(?:home|etc|var)\//, /"oldText"/, /"newText"/, /"source"/, /"path"/, /"anchor"/, /-----BEGIN/, /\bsk-[A-Za-z0-9]{8,}\b/];
  return requests.every((request) => forbidden.every((pattern) => !pattern.test(request)));
}

async function runJeq(cases: readonly PreparedCase[], outDir: string, budget: number): Promise<OccurrenceResult[]> {
  const requestDir = path.join(outDir, "requests");
  await fs.mkdir(requestDir, { recursive: true });
  const results: OccurrenceResult[] = [];
  for (const [index, entry] of cases.slice(0, budget).entries()) {
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}.json`);
    await fs.writeFile(requestFile, entry.request);
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
      const response = parseOccurrenceResponse(stdout, entry.options);
      if (!response) {
        results.push({ caseId: entry.episode.episodeId, sessionId: entry.episode.sessionId, status: "malformed", latencyMs: Date.now() - started });
        continue;
      }
      results.push({
        caseId: entry.episode.episodeId,
        sessionId: entry.episode.sessionId,
        status: response.choice === "none" ? "abstained" : "answered",
        choice: response.choice,
        ...(response.confidence === undefined ? {} : { confidence: response.confidence }),
        latencyMs: Date.now() - started,
      });
    } catch {
      results.push({ caseId: entry.episode.episodeId, sessionId: entry.episode.sessionId, status: "failed", latencyMs: Date.now() - started });
    }
  }
  return results;
}

async function commandRun(args: Args): Promise<void> {
  const { sessions, attrition, cases } = await collect(args.sessions);
  const labelable: LabelableCase[] = cases.map((entry) => ({
    caseId: entry.episode.episodeId,
    sessionId: entry.episode.sessionId,
    labelOrdinal: entry.episode.labelOrdinal!,
    ...(entry.baselineNearest === undefined ? {} : { baselineNearest: entry.baselineNearest }),
  }));
  const privacyPass = occurrenceRequestPrivacyPasses(cases.map((entry) => entry.request));
  // End-to-end coverage: labelable over all mined eligible failures.
  const coverage = attrition.mined === 0 ? 0 : labelable.length / attrition.mined;

  const report: Record<string, unknown> = {
    label: "direction evidence only",
    sessions,
    attrition,
    candidateCases: cases.length,
    labelable: labelable.length,
    coverage,
    distinctSessions: new Set(labelable.map((entry) => entry.sessionId)).size,
    requestPrivacyPass: privacyPass,
    gate: OCCURRENCE_PROMOTION_GATE,
  };

  const shouldRun = args.jeq && labelable.length >= MIN_LABELABLE && privacyPass;
  if (shouldRun) {
    const results = await runJeq(cases, args.out, args.budget);
    const metrics = evaluateOccurrences(labelable, results);
    report.metrics = metrics;
    report.verdict = decideOccurrences(coverage, metrics, labelable.length);
    report.evaluated = results.length;
  } else {
    report.evaluated = 0;
    report.verdict = !privacyPass
      ? { verdict: "reject", reason: "request-privacy-tests-failed" }
      : labelable.length < MIN_LABELABLE
        ? { verdict: "reject", reason: `insufficient-labelable-cases: ${labelable.length} < ${MIN_LABELABLE}` }
        : { verdict: "shadow-only", reason: "jeq not run in this invocation" };
  }

  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
