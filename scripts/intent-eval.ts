#!/usr/bin/env node
/**
 * TASK-0029 — evaluate case-specific agent-intent hypotheses with `jeq`.
 *
 * Extract real failed calls with a later successful recovery from the session
 * corpus. Requests carry ONLY pre-failure structural context. Hypotheses are
 * deterministic causal intent claims. Ground truth (later success) is hidden.
 *
 * Validity limit: the later success is a FUTURE-BEHAVIOR PROXY for intent — the
 * first later successful call may be unrelated work. Results measure agreement
 * with that proxy, not verified causal intent.
 * Offline only; zero retries; no runtime integration.
 *
 * Usage:
 *   node --experimental-strip-types scripts/intent-eval.ts run [--sessions <dir>] [--out <dir>] [--budget <n>]
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  argShapeOf,
  boundPriorTools,
  classifyFailureFamily,
  failureClassOf,
  buildIntentState,
  type FailureFamily,
  type IntentContext,
  type PriorToolObservation,
} from "../src/intent/context.ts";
import {
  INTENT_QUESTION_INSTRUCTIONS,
  hypothesisCriteria,
  labelFor,
  validIntentIds,
  type IntentLabel,
  type SuccessObservation,
} from "../src/intent/hypotheses.ts";
import { evaluateIntent, parseIntentResponse, type IntentResult } from "../src/intent/metrics.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_OUT = ".tmp/intent-eval";
const DEFAULT_BUDGET = 60;

interface Args { command: string; sessions: string; out: string; budget: number }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", sessions: path.join(homedir(), ".pi", "agent", "sessions"), out: DEFAULT_OUT, budget: DEFAULT_BUDGET };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--sessions": args.sessions = argv[++index] ?? args.sessions; break;
      case "--out": args.out = argv[++index] ?? args.out; break;
      case "--budget": args.budget = Number(argv[++index] ?? args.budget); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

interface ExtractedCase {
  caseId: string;
  context: IntentContext;
  label: IntentLabel;
}

interface ToolRecord {
  toolCallId: string;
  ts: string;
  toolName: string;
  input: Record<string, unknown>;
  errorText?: string;
  isError: boolean;
}

/** Reads one transcript into ordered tool records (calls joined with results). */
async function readTranscript(filePath: string): Promise<{ sessionId: string; cwd: string; records: ToolRecord[] } | undefined> {
  const text = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let sessionId = "";
  let cwd = "";
  const byId = new Map<string, Partial<ToolRecord>>();
  const order: string[] = [];

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
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        byId.set(block.id, { toolCallId: block.id, ts: entry.timestamp, toolName: block.name, input: block.arguments ?? {} });
        order.push(block.id);
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && byId.has(message.toolCallId)) {
      const record = byId.get(message.toolCallId)!;
      record.isError = message.isError === true;
      const errorText = (Array.isArray(message.content) ? message.content : [])
        .map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("");
      if (errorText) record.errorText = errorText;
    }
  }

  const records: ToolRecord[] = [];
  for (const id of order) {
    const record = byId.get(id)!;
    if (typeof record.isError !== "boolean" || typeof record.toolName !== "string") continue;
    records.push({ toolCallId: id, ts: record.ts!, toolName: record.toolName, input: record.input ?? {}, ...(record.errorText === undefined ? {} : { errorText: record.errorText }), isError: record.isError });
  }
  return sessionId && cwd ? { sessionId, cwd, records } : undefined;
}

/** Deterministic edit-locator extension check without transmitting either text. */
function extendsLocator(earlier: Record<string, unknown>, later: Record<string, unknown>): boolean {
  const earlierEdits = Array.isArray(earlier.edits) ? earlier.edits : [];
  const laterEdits = Array.isArray(later.edits) ? later.edits : [];
  const earlierOld = (earlierEdits[0] as any)?.oldText;
  const laterOld = (laterEdits[0] as any)?.oldText;
  return typeof earlierOld === "string" && typeof laterOld === "string" && laterOld.includes(earlierOld) && laterOld.length > earlierOld.length;
}

function sameTarget(earlier: Record<string, unknown>, later: Record<string, unknown>): boolean {
  const earlierTarget = earlier.path;
  const laterTarget = later.path;
  return typeof earlierTarget === "string" && earlierTarget === laterTarget;
}

/** Extracts labeled intent cases from a transcript (pre-failure context only). */
function extractCases(transcript: { sessionId: string; records: ToolRecord[] }): ExtractedCase[] {
  const cases: ExtractedCase[] = [];
  const { records } = transcript;

  for (let index = 0; index < records.length; index++) {
    const failed = records[index]!;
    if (!failed.isError) continue;
    const family = classifyFailureFamily(failed.toolName, failed.errorText ?? "", failed.input);
    if (!family) continue;

    const successIndex = records.findIndex((candidate, candidateIndex) => candidateIndex > index && !candidate.isError);
    if (successIndex === -1) continue;
    const success = records[successIndex]!;
    if (records.slice(index + 1, successIndex).some((between) => between.toolName === failed.toolName && !between.isError)) continue;

    const successObservation: SuccessObservation = {
      toolName: success.toolName,
      ...(family === "ambiguous-edit" || family === "edit-mismatch" ? { extendsFailedLocator: extendsLocator(failed.input, success.input) } : {}),
      ...(family === "invalid-shape" ? { sameTarget: sameTarget(failed.input, success.input) } : {}),
    };
    const label = labelFor(family as FailureFamily, successObservation, failed.toolName);
    const priorTools: PriorToolObservation[] = records.slice(Math.max(0, index - 4), index)
      .map((record) => ({ name: record.toolName, outcome: record.isError ? "error" as const : "ok" as const }));
    const { argKeys, argTypes } = argShapeOf(failed.input);

    cases.push({
      caseId: `${transcript.sessionId}:${failed.toolCallId}`,
      context: {
        family: family as FailureFamily,
        attemptedTool: failed.toolName,
        argKeys,
        argTypes,
        failureClass: failureClassOf(family as FailureFamily, failed.toolName),
        priorTools: boundPriorTools(priorTools),
      },
      label,
    });
  }
  return cases;
}

async function collectCases(sessionsDir: string): Promise<ExtractedCase[]> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const cases: ExtractedCase[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const transcript = await readTranscript(path.join(dirPath, file));
      if (transcript) cases.push(...extractCases(transcript));
    }
  }
  return cases;
}

function buildRequest(context: IntentContext): string {
  return JSON.stringify({
    model: process.env.JEQ_MODEL ?? "jev-latest",
    state: buildIntentState(context),
    questions: {
      hypothesis: { type: "choice", instructions: INTENT_QUESTION_INSTRUCTIONS, criteria: hypothesisCriteria(context.family) },
    },
  });
}

async function commandRun(args: Args): Promise<void> {
  const extracted = await collectCases(args.sessions);
  const labeled = extracted.filter((evaluationCase) => evaluationCase.label !== "unresolvable");
  const selected = labeled.slice(0, args.budget);

  const requestDir = path.join(args.out, "requests");
  await fs.mkdir(requestDir, { recursive: true });
  const results: IntentResult[] = [];

  for (const [index, evaluationCase] of selected.entries()) {
    const validIds = validIntentIds(evaluationCase.context.family);
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}-${evaluationCase.caseId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    await fs.writeFile(requestFile, buildRequest(evaluationCase.context));
    const started = Date.now();
    const latencyMs = () => Date.now() - started;
    try {
      const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
      const response = parseIntentResponse(stdout, validIds);
      if (!response) {
        results.push({ caseId: evaluationCase.caseId, family: evaluationCase.context.family, label: evaluationCase.label, status: "malformed", latencyMs: latencyMs() });
        continue;
      }
      results.push({
        caseId: evaluationCase.caseId,
        family: evaluationCase.context.family,
        label: evaluationCase.label,
        status: response.choice === "uncertain" ? "uncertain" : "answered",
        choice: response.choice,
        ...(response.confidence === undefined ? {} : { confidence: response.confidence }),
        probabilities: response.probabilities,
        latencyMs: latencyMs(),
      });
    } catch {
      results.push({ caseId: evaluationCase.caseId, family: evaluationCase.context.family, label: evaluationCase.label, status: "failed", latencyMs: latencyMs() });
    }
  }

  const metrics = evaluateIntent(results);
  await fs.mkdir(args.out, { recursive: true });
  const report = {
    label: "direction evidence only",
    extracted: extracted.length,
    labeled: labeled.length,
    unresolvable: extracted.length - labeled.length,
    evaluated: results.length,
    metrics,
    results,
  };
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ extracted: extracted.length, labeled: labeled.length, evaluated: results.length, metrics }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
