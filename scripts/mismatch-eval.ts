#!/usr/bin/env node
/**
 * TASK-0031 — bounded edit-mismatch candidate evaluation.
 *
 * Offline first: mine episodes, generate candidates, report attrition and
 * recall. The installed `jeq` runs ONLY when there are >= 30 labelable cases
 * and request privacy tests pass. No runtime integration.
 *
 * Usage:
 *   node --experimental-strip-types scripts/mismatch-eval.ts run [--sessions <dir>] [--out <dir>] [--budget <n>]
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { generateMismatchCandidates, labelOrdinal } from "../src/mismatch/candidates.ts";
import { extractMismatchCases } from "../src/mismatch/episode.ts";
import { parseSessionText } from "../src/mismatch/session.ts";
import {
  MISMATCH_PROMOTION_GATE,
  buildMismatchRequest,
  candidateOptions,
  computeRecall,
  decideMismatch,
  evaluateMismatch,
  parseMismatchResponse,
  type MismatchResult,
} from "../src/mismatch/evaluation.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_OUT = ".tmp/mismatch-eval";
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

interface CandidateCase {
  caseId: string;
  labelOrdinal?: number;
  candidateCount: number;
  options: string[];
  request: string;
}

async function collect(sessionsDir: string): Promise<{ sessions: number; mined: number; cases: CandidateCase[] }> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  let sessions = 0;
  let mined = 0;
  const cases: CandidateCase[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const text = await fs.readFile(path.join(dirPath, file), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const session = parseSessionText(text);
      if (!session.sessionId) continue;
      sessions++;
      const extracted = extractMismatchCases(session.sessionId, session.events);
      mined += extracted.length;
      for (const evaluationCase of extracted) {
        const candidates = generateMismatchCandidates(evaluationCase.attemptedOldText);
        if (candidates.length === 0) continue;
        cases.push({
          caseId: evaluationCase.caseId,
          ...(labelOrdinal(candidates, evaluationCase.successfulOldText) === undefined ? {} : { labelOrdinal: labelOrdinal(candidates, evaluationCase.successfulOldText)! }),
          candidateCount: candidates.length,
          options: candidateOptions(candidates),
          request: JSON.stringify(buildMismatchRequest(evaluationCase, candidates)),
        });
      }
    }
  }
  return { sessions, mined, cases };
}

/** Request privacy gate: no paths, source, edit text, identifiers, or future behavior. */
export function requestPrivacyPasses(requests: readonly string[]): boolean {
  const forbidden = [/\/Users\//, /\/(?:home|etc|var)\//, /oldText/, /newText/, /"path"/, /SECRET/, /-----BEGIN/, /\bsk-[A-Za-z0-9]{8,}\b/];
  return requests.every((request) => forbidden.every((pattern) => !pattern.test(request)));
}

async function runJeq(cases: readonly CandidateCase[], outDir: string, budget: number): Promise<MismatchResult[]> {
  const requestDir = path.join(outDir, "requests");
  await fs.mkdir(requestDir, { recursive: true });
  const results: MismatchResult[] = [];
  for (const [index, evaluationCase] of cases.slice(0, budget).entries()) {
    const options = evaluationCase.options;
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}.json`);
    await fs.writeFile(requestFile, evaluationCase.request);
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
      const response = parseMismatchResponse(stdout, options);
      if (!response) {
        results.push({ caseId: evaluationCase.caseId, status: "malformed", latencyMs: Date.now() - started });
        continue;
      }
      results.push({
        caseId: evaluationCase.caseId,
        status: response.choice === "none" ? "abstained" : "answered",
        choice: response.choice,
        ...(response.confidence === undefined ? {} : { confidence: response.confidence }),
        latencyMs: Date.now() - started,
      });
    } catch {
      results.push({ caseId: evaluationCase.caseId, status: "failed", latencyMs: Date.now() - started });
    }
  }
  return results;
}

async function commandRun(args: Args): Promise<void> {
  const { sessions, mined, cases } = await collect(args.sessions);
  // Count labelable only among cases; recall denominator is all mined candidate cases.
  const recall = computeRecall(cases);
  const labelable = cases.filter((entry) => entry.labelOrdinal !== undefined);
  const distinctSessions = new Set(labelable.map((entry) => entry.caseId.split("#")[0]));
  const privacyPass = requestPrivacyPasses(cases.map((entry) => entry.request));

  const report: Record<string, unknown> = {
    label: "direction evidence only",
    sessions,
    minedCases: mined,
    candidateCases: cases.length,
    labelable: labelable.length,
    distinctSessions: distinctSessions.size,
    recall,
    requestPrivacyPass: privacyPass,
    gate: MISMATCH_PROMOTION_GATE,
  };

  const shouldRunJev = args.jeq && labelable.length >= MIN_LABELABLE && privacyPass;
  if (shouldRunJev) {
    const results = await runJeq(labelable, args.out, args.budget);
    const metrics = evaluateMismatch(labelable, results);
    report.jev = { metrics, verdict: decideMismatch(recall, metrics, labelable.length) };
    report.attrition = { mined: mined, candidateCases: cases.length, labelable: labelable.length, evaluated: results.length };
  } else {
    report.attrition = { mined: mined, candidateCases: cases.length, labelable: labelable.length, evaluated: 0 };
    report.jev = {
      skipped: true,
      reason: !privacyPass ? "request-privacy-tests-failed" : `labelable cases ${labelable.length} < ${MIN_LABELABLE}`,
    };
    report.verdict = !privacyPass
      ? { verdict: "reject", reason: "request-privacy-tests-failed" }
      : labelable.length < MIN_LABELABLE
        ? { verdict: "reject", reason: `insufficient-labelable-cases: ${labelable.length} < ${MIN_LABELABLE}` }
        : recall.top5Recall < MISMATCH_PROMOTION_GATE.minRecall
          ? { verdict: "reject", reason: `candidate top-5 recall ${recall.top5Recall.toFixed(3)} < ${MISMATCH_PROMOTION_GATE.minRecall}` }
          : { verdict: "shadow-only", reason: "jeq not run in this invocation" };
  }

  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
