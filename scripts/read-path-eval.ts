#!/usr/bin/env node
/**
 * TASK-0022 — offline missing-read path evaluation.
 *
 * Usage (from the pi-welder extension directory):
 *
 *   1) Offline pair mining + candidate hit rates (zero API calls):
 *        node --experimental-strip-types scripts/read-path-eval.ts pairs
 *
 *   2) Offline Jev evaluation over the pairs (opt-in; approval gate):
 *        TYPESAFE_API_KEY=... node --experimental-strip-types scripts/read-path-eval.ts jev --execute
 *          [--sessions <dir>] [--out <dir>] [--budget <n>]
 *
 * Privacy: requests carry only relative requested/candidate paths. Persisted
 * metadata never contains paths — only lengths, counts, and statuses.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { createTypeSafeJevClient } from "../src/infra/typesafe.ts";
import { generateReadPathCandidates } from "../src/read-recovery/candidates.ts";
import { READ_PATH_PROMPT, buildReadPathRequest, runReadPathSelection, type ReadPathPlan } from "../src/read-recovery/path-repair.ts";
import { computeHitRates, isMissingPathError, mineMissingReadPairs, pairMetadata, type MissingReadPair, type ReadTranscript } from "../src/read-recovery/pair-miner.ts";
import { evaluateReadPathGate, READ_PATH_GATE, type ReadPathEvidence } from "../src/read-recovery/evidence-gate.ts";

interface Args {
  command: string;
  sessions: string;
  out: string;
  budget: number;
  execute: boolean;
}

const DEFAULT_OUT = ".tmp/read-path-eval";
const DEFAULT_BUDGET = 200;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "pairs",
    sessions: path.join(homedir(), ".pi", "agent", "sessions"),
    out: DEFAULT_OUT,
    budget: DEFAULT_BUDGET,
    execute: false,
  };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--execute": args.execute = true; break;
      case "--sessions": args.sessions = requireValue(argv, index++); break;
      case "--out": args.out = requireValue(argv, index++); break;
      case "--budget": args.budget = Number(requireValue(argv, index++)); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  if (!Number.isInteger(args.budget) || args.budget < 0) throw new Error("--budget must be a non-negative integer");
  args.budget = Math.min(args.budget, DEFAULT_BUDGET);
  return args;
}

function requireValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Flag ${argv[index]} requires a value`);
  return value;
}

async function readReadTranscript(filePath: string): Promise<ReadTranscript | undefined> {
  const text = await readFile(filePath, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let sessionId = "";
  let cwd = "";
  const calls: ReadTranscript["calls"] = [];
  const outcomes: ReadTranscript["outcomes"] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    const message = entry.message;
    if (!message || typeof entry.timestamp !== "string") continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || block.name !== "read" || typeof block.id !== "string") continue;
        const callPath = block.arguments?.path;
        if (typeof callPath === "string") calls.push({ toolCallId: block.id, ts: entry.timestamp, path: callPath });
      }
      continue;
    }
    if (message.role === "toolResult" && message.toolName === "read" && typeof message.toolCallId === "string") {
      const errorText = (Array.isArray(message.content) ? message.content : [])
        .map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("");
      outcomes.push({ toolCallId: message.toolCallId, isError: message.isError === true, errorText });
    }
  }
  if (!sessionId || !cwd) return undefined;
  return { sessionId, cwd, calls, outcomes };
}

async function collectTranscripts(sessionsDir: string): Promise<ReadTranscript[]> {
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const transcripts: ReadTranscript[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const transcript = await readReadTranscript(path.join(dirPath, file));
      if (transcript) transcripts.push(transcript);
    }
  }
  return transcripts;
}

interface PairCandidates {
  pair: MissingReadPair;
  candidates: string[];
}

/** Relative candidate list for a pair, or undefined when ineligible. */
async function candidatesForPair(pair: MissingReadPair): Promise<string[] | undefined> {
  const candidates = await generateReadPathCandidates({ cwd: pair.cwd, requestedPath: pair.missingPath });
  return candidates?.map((candidate) => candidate.path);
}

/** Ground-truth candidate ordinal for the eventual successful read. */
function groundTruthOrdinal(pair: MissingReadPair, candidates: readonly string[]): number | undefined {
  const normalized = path.relative(pair.cwd, path.resolve(pair.cwd, pair.successPath)).split(path.sep).join("/");
  if (normalized.startsWith("..")) return undefined;
  const index = candidates.indexOf(normalized);
  return index === -1 ? undefined : index + 1;
}

async function mineAndEvaluate(sessionsDir: string): Promise<{ pairs: MissingReadPair[]; withCandidates: PairCandidates[]; hitRates: ReturnType<typeof computeHitRates> }> {
  const transcripts = await collectTranscripts(sessionsDir);
  const pairs = transcripts.flatMap((transcript) => mineMissingReadPairs(transcript));
  const candidateMap = new Map<MissingReadPair, string[]>();
  const withCandidates: PairCandidates[] = [];
  for (const pair of pairs) {
    const candidates = await candidatesForPair(pair);
    if (!candidates || candidates.length === 0) continue;
    candidateMap.set(pair, candidates);
    withCandidates.push({ pair, candidates });
  }
  const hitRates = computeHitRates(pairs, (pair) => candidateMap.get(pair));
  return { pairs, withCandidates, hitRates };
}

async function commandPairs(args: Args): Promise<void> {
  const { pairs, withCandidates, hitRates } = await mineAndEvaluate(args.sessions);

  await mkdir(args.out, { recursive: true });
  const columns = ["sessionId", "failedToolCallId", "failedTs", "successToolCallId", "successTs", "missingPathLength", "successPathLength", "sameBasename"] as const;
  const metadata = pairs.map(pairMetadata);
  const tsv = [columns.join("\t"), ...metadata.map((row) => columns.map((column) => String(row[column])).join("\t"))].join("\n") + "\n";
  await writeFile(path.join(args.out, "pairs.tsv"), tsv);
  await writeFile(path.join(args.out, "summary.json"), JSON.stringify({ pairs: pairs.length, withCandidates: withCandidates.length, hitRates }, null, 2) + "\n");

  console.log(JSON.stringify({
    pairs: pairs.length,
    pairsWithCandidates: withCandidates.length,
    top1: hitRates.top1,
    top5: hitRates.top5,
    top1Rate: hitRates.top1Rate,
    top5Rate: hitRates.top5Rate,
    apiCalls: 0,
  }, null, 2));
}

async function commandJev(args: Args): Promise<void> {
  if (!args.execute) throw new Error("Real API evaluation requires --execute (approval gate).");
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("--execute requires TYPESAFE_API_KEY");

  const { pairs, withCandidates, hitRates } = await mineAndEvaluate(args.sessions);
  const client = createTypeSafeJevClient({ apiKey, prompt: READ_PATH_PROMPT });

  let attempted = 0;
  let correct = 0;
  let wrongTargets = 0;
  let abstained = 0;
  let unresolved = 0;
  const statuses: Record<string, number> = {};

  for (const { pair, candidates } of withCandidates.slice(0, args.budget)) {
    const truth = groundTruthOrdinal(pair, candidates);
    if (truth === undefined) { unresolved++; continue; }
    const plan: ReadPathPlan = { requestedPath: pair.missingPath, candidates: candidates.map((candidate, index) => ({ ordinal: index + 1, path: candidate })) };
    const result = await runReadPathSelection({ client, plan });
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    if (result.status !== "selected") { abstained++; continue; }
    attempted++;
    if (result.selectedOrdinal === truth) correct++;
    else wrongTargets++;
  }

  // Provisional only: no human-reviewed labels exist for this set.
  const evidence: ReadPathEvidence = {
    pairs: pairs.length,
    reviewedLabels: 0,
    attemptedSelections: attempted,
    correct,
    wrongTargets,
    precision: attempted === 0 ? undefined : correct / attempted,
  };
  const verdict = evaluateReadPathGate(evidence);

  // Explicit accounting: rates are over candidate-eligible pairs, not mined
  // pairs. cap = unresolved + evaluated; evaluated = the terminal statuses.
  const cap = Math.min(withCandidates.length, args.budget);
  const accounting = {
    minedPairs: pairs.length,
    candidateEligible: withCandidates.length,
    cap,
    beyondCap: withCandidates.length - cap,
    unresolved,
    evaluated: attempted + abstained,
    statuses,
  };

  await mkdir(args.out, { recursive: true });
  const report = {
    label: "direction evidence only",
    gate: READ_PATH_GATE,
    hitRates,
    provisional: { ...evidence, abstained, unresolved, statuses },
    accounting,
    verdict,
    // Privacy: the request payload shape only; no paths are written.
    requestShape: JSON.stringify(buildReadPathRequest({ requestedPath: "<relative>", candidates: [{ ordinal: 1, path: "<relative>" }] })),
  };
  await writeFile(path.join(args.out, "jev-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "pairs") await commandPairs(args);
else if (args.command === "jev") await commandJev(args);
else throw new Error(`Unknown command ${args.command} (use: pairs | jev)`);
