#!/usr/bin/env node
/**
 * TASK-0024 offline replay tooling: bootstrap shadow labels from historical
 * ambiguous edits. Deterministic: the same session corpus produces identical
 * pairs and a byte-identical pairs file.
 *
 * Usage (run from the pi-welder extension directory):
 *
 *   1) Count extraction and validity attrition with ZERO API calls:
 *        node --experimental-strip-types scripts/shadow-replay.ts dry-run \
 *          [--sessions <dir>] [--budget <n>] [--out <pairs.tsv>]
 *
 *   2) Replay valid pairs through the existing JevClient (requires approval:
 *      pass --execute plus TYPESAFE_API_KEY; budget <= 200, sequential,
 *      2s timeout, zero retries):
 *        node --experimental-strip-types scripts/shadow-replay.ts replay --execute \
 *          [--sessions <dir>] [--budget <n>] [--worksheet <file>] [--log <file>]
 *
 * Privacy: persisted artifacts use the closed metadata schema only — session
 * ids, opaque toolCallIds, timestamps, lengths, counts, ordinals, statuses.
 * Source windows, paths, and edit text never leave memory. All artifacts stay
 * under .tmp/ (git-ignored).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createTypeSafeJevClient } from "../src/infra/typesafe.ts";
import { mineAmbiguousPairs, reportedOccurrences, type ReplayPair, type SessionTranscript, type TranscriptEditCall, type TranscriptEditOutcome } from "../src/model-recovery/replay-pairs.ts";
import { evaluatePairValidity } from "../src/model-recovery/replay-validity.ts";
import { REPLAY_BUDGET, buildReplayWorksheet, runShadowReplay, type PreparedPair, type ReplayCallRecord } from "../src/model-recovery/replay-run.ts";

interface Args {
  command: string;
  sessions: string;
  out: string;
  worksheet: string;
  log: string;
  budget: number;
  execute: boolean;
}

const DEFAULT_ARTIFACTS = ".tmp/shadow-replay";

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "dry-run",
    sessions: path.join(homedir(), ".pi", "agent", "sessions"),
    out: path.join(DEFAULT_ARTIFACTS, "pairs.tsv"),
    worksheet: path.join(DEFAULT_ARTIFACTS, "worksheet.tsv"),
    log: path.join(DEFAULT_ARTIFACTS, "call-log.jsonl"),
    budget: REPLAY_BUDGET,
    execute: false,
  };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--execute": args.execute = true; break;
      case "--sessions": args.sessions = requireValue(argv, index++); break;
      case "--out": args.out = requireValue(argv, index++); break;
      case "--worksheet": args.worksheet = requireValue(argv, index++); break;
      case "--log": args.log = requireValue(argv, index++); break;
      case "--budget": args.budget = Number(requireValue(argv, index++)); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  if (!Number.isInteger(args.budget) || args.budget < 0) throw new Error("--budget must be a non-negative integer");
  // Protocol cap (fixed PO scope): the flag may lower the budget, never exceed it.
  args.budget = Math.min(args.budget, REPLAY_BUDGET);
  return args;
}

function requireValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Flag ${argv[index]} requires a value`);
  return value;
}

// --- transcript extraction (metadata + in-memory edit text only) --------------

interface SessionFile { transcript: SessionTranscript; editFailures: number; ambiguousFailures: number; editCalls: number }

async function readTranscript(filePath: string): Promise<SessionFile | undefined> {
  const text = await readFile(filePath, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let sessionId = "";
  let cwd = "";
  const calls: TranscriptEditCall[] = [];
  const outcomes: TranscriptEditOutcome[] = [];
  let editCalls = 0;
  let editFailures = 0;
  let ambiguousFailures = 0;

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
        if (block?.type !== "toolCall" || block.name !== "edit" || typeof block.id !== "string") continue;
        editCalls++;
        const single = singleEditOf(block.arguments);
        if (single) calls.push({ toolCallId: block.id, ts: entry.timestamp, path: single.path, oldText: single.oldText, newText: single.newText });
      }
      continue;
    }
    if (message.role === "toolResult" && message.toolName === "edit" && typeof message.toolCallId === "string") {
      const isError = message.isError === true;
      const errorText = (Array.isArray(message.content) ? message.content : [])
        .map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("");
      if (isError) {
        editFailures++;
        const occurrences = reportedOccurrences(errorText);
        if (occurrences !== undefined && occurrences >= 2 && occurrences <= 5) ambiguousFailures++;
      }
      outcomes.push({ toolCallId: message.toolCallId, isError, errorText });
    }
  }
  if (!sessionId || !cwd) return undefined;
  return { transcript: { sessionId, cwd, calls, outcomes }, editCalls, editFailures, ambiguousFailures };
}

function singleEditOf(arguments_: unknown): { path: string; oldText: string; newText: string } | undefined {
  if (!arguments_ || typeof arguments_ !== "object") return undefined;
  const input = arguments_ as Record<string, unknown>;
  if (typeof input.path !== "string") return undefined;
  if (!Array.isArray(input.edits) || input.edits.length !== 1) return undefined;
  const edit = input.edits[0] as Record<string, unknown> | undefined;
  if (!edit || typeof edit !== "object") return undefined;
  const { oldText, newText } = edit;
  if (typeof oldText !== "string" || typeof newText !== "string" || oldText.length === 0) return undefined;
  return { path: input.path, oldText, newText };
}

async function collectSessions(sessionsDir: string): Promise<SessionFile[]> {
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const collected: SessionFile[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const session = await readTranscript(path.join(dirPath, file));
      if (session) collected.push(session);
    }
  }
  return collected;
}

// --- closed metadata artifacts (no paths, no edit text) ------------------------

const PAIR_COLUMNS = [
  "sessionId",
  "failedToolCallId",
  "failedTs",
  "successfulToolCallId",
  "successfulTs",
  "failedOccurrences",
  "failedOldTextLength",
  "successfulOldTextLength",
  "validity",
  "reason",
  "candidateCount",
  "groundTruthOrdinal",
] as const;

interface PairMetadata {
  sessionId: string;
  failedToolCallId: string;
  failedTs: string;
  successfulToolCallId: string;
  successfulTs: string;
  failedOccurrences: number;
  failedOldTextLength: number;
  successfulOldTextLength: number;
  validity: "valid" | "invalid" | "unresolvable";
  reason: string;
  candidateCount: number;
  groundTruthOrdinal: number;
}

function metadataOf(pair: ReplayPair, validity: Awaited<ReturnType<typeof evaluatePairValidity>>): PairMetadata {
  return {
    sessionId: pair.sessionId,
    failedToolCallId: pair.failedToolCallId,
    failedTs: pair.failedTs,
    successfulToolCallId: pair.successfulToolCallId,
    successfulTs: pair.successfulTs,
    failedOccurrences: pair.failedOccurrences,
    failedOldTextLength: pair.failedOldTextLength,
    successfulOldTextLength: pair.successfulOldTextLength,
    validity: validity.verdict,
    reason: validity.verdict === "valid" ? "" : validity.reason,
    candidateCount: validity.verdict === "valid" ? validity.candidateCount : 0,
    groundTruthOrdinal: validity.verdict === "valid" ? validity.groundTruthOrdinal : 0,
  };
}

function renderPairs(rows: readonly PairMetadata[]): string {
  return [PAIR_COLUMNS.join("\t"),
    ...rows.map((row) => PAIR_COLUMNS.map((column) => String(row[column])).join("\t"))].join("\n") + "\n";
}

// --- commands ------------------------------------------------------------------

interface Evaluation {
  metadata: PairMetadata[];
  prepared: PreparedPair[];
  counts: { pairs: number; valid: number; invalid: number; unresolvable: number };
}

async function mineAndEvaluate(args: Args): Promise<{ sessions: number; editCalls: number; editFailures: number; ambiguousFailures: number } & Evaluation> {
  const sessionFiles = await collectSessions(args.sessions);
  const metadata: PairMetadata[] = [];
  const prepared: PreparedPair[] = [];
  const counts = { pairs: 0, valid: 0, invalid: 0, unresolvable: 0 };

  for (const session of sessionFiles) {
    const pairs = mineAmbiguousPairs(session.transcript);
    counts.pairs += pairs.length;
    for (const pair of pairs) {
      const validity = await evaluatePairValidity(pair);
      metadata.push(metadataOf(pair, validity));
      if (validity.verdict !== "valid") { counts[validity.verdict]++; continue; }
      counts.valid++;
      prepared.push({
        sessionId: pair.sessionId,
        toolCallId: pair.failedToolCallId,
        ts: pair.failedTs,
        candidateCount: validity.candidateCount,
        groundTruthOrdinal: validity.groundTruthOrdinal,
        request: validity.request,
      });
    }
  }
  return {
    sessions: sessionFiles.length,
    editCalls: sessionFiles.reduce((total, session) => total + session.editCalls, 0),
    editFailures: sessionFiles.reduce((total, session) => total + session.editFailures, 0),
    ambiguousFailures: sessionFiles.reduce((total, session) => total + session.ambiguousFailures, 0),
    metadata,
    prepared,
    counts,
  };
}

async function commandDryRun(args: Args): Promise<void> {
  // Dry-run contract: extraction + validity only. No client exists here, so
  // zero API calls are possible by construction.
  const result = await mineAndEvaluate(args);
  await mkdir(path.parse(args.out).dir, { recursive: true });
  await writeFile(args.out, renderPairs(result.metadata));
  const plannedCalls = Math.min(result.prepared.length, args.budget);
  console.log(JSON.stringify({
    sessions: result.sessions,
    editCalls: result.editCalls,
    editFailures: result.editFailures,
    ambiguousFailures: result.ambiguousFailures,
    pairs: result.counts.pairs,
    validitySurvivors: result.counts.valid,
    invalid: result.counts.invalid,
    unresolvable: result.counts.unresolvable,
    budget: args.budget,
    plannedCalls,
    budgetHeadroom: args.budget - plannedCalls,
    pairsFile: args.out,
    apiCalls: 0,
  }, null, 2));
}

async function commandReplay(args: Args): Promise<void> {
  if (!args.execute) throw new Error("Real API replay is a separate approval gate: pass --execute (plus TYPESAFE_API_KEY) only when approved.");
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for replay mode");

  const result = await mineAndEvaluate(args);
  const client = createTypeSafeJevClient({ apiKey });
  const run = await runShadowReplay({ prepared: result.prepared, client, budget: args.budget });

  await mkdir(path.parse(args.worksheet).dir, { recursive: true });
  await writeFile(args.worksheet, buildReplayWorksheet(run.rows));
  await mkdir(path.parse(args.log).dir, { recursive: true });
  await writeFile(args.log, run.calls.map((record: ReplayCallRecord) => JSON.stringify(record)).join("\n") + (run.calls.length ? "\n" : ""));

  console.log(JSON.stringify({
    pairs: result.counts.pairs,
    validitySurvivors: result.counts.valid,
    replayed: run.stats.attempted,
    budget: run.stats.budget,
    budgetHeadroom: run.stats.headroom,
    selected: run.rows.filter((row) => row.outcome === "selected").length,
    worksheet: args.worksheet,
    callLog: args.log,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "dry-run") await commandDryRun(args);
else if (args.command === "replay") await commandReplay(args);
else throw new Error(`Unknown command ${args.command} (use: dry-run | replay)`);
