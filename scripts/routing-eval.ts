#!/usr/bin/env node
/**
 * TASK-0021 — offline failure-to-repair-rule routing evaluation.
 *
 * Deterministic routing runs first; only cases it leaves unresolved are sent
 * to `jeq` (TypeSafe System One Choice, `--max-retries 0`). Offline only: no
 * runtime integration.
 *
 * Usage (from the pi-welder extension directory):
 *
 *   node --experimental-strip-types scripts/routing-eval.ts run [--budget <n>] [--out <dir>]
 *
 * Privacy: outbound state is {toolName, errorKind, sanitized errorText} only —
 * no paths, source, commands, edit text, or credentials.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { LABELED_FAILURES, type LabeledFailure, type RoutingLabel } from "../src/routing/dataset.ts";
import { buildRoutingState, type RoutingState } from "../src/routing/sanitize.ts";
import {
  ROUTING_POLICY,
  decideRouting,
  deterministicRoute,
  evaluateRouting,
  parseRouteAnswer,
  type JevRouteResult,
  type RoutingAnswer,
} from "../src/routing/policy.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_OUT = ".tmp/routing-eval";
const DEFAULT_BUDGET = 60;

interface Args { command: string; budget: number; out: string }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", budget: DEFAULT_BUDGET, out: DEFAULT_OUT };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--budget": args.budget = Number(argv[index + 1] ?? args.budget); index++; break;
      case "--out": args.out = argv[index + 1] ?? args.out; index++; break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

/** The closed question: only enumerated rule IDs or none. */
const RULE_CRITERIA: Record<string, string> = {
  "resolve-ambiguous-edit": "An edit's oldText cannot be located exactly (not found, ambiguous, or overlapping); expand context or normalize whitespace.",
  "edit-noop": "An edit failed because the replacement equals existing content.",
  "missing-read-context": "A read targeted a path that does not exist.",
  "directory-read": "A read targeted a directory instead of a file.",
  "read-offset-context": "A read offset is beyond the end of the file.",
  none: "No deterministic repair rule should handle this failure.",
};

const QUESTION_INSTRUCTIONS =
  "A tool call failed. Choose the single deterministic repair rule that should handle this failure, " +
  "or none when no existing rule applies. Choose only from the listed criteria.";

export function buildRoutingRequest(state: RoutingState): string {
  return JSON.stringify({
    model: process.env.JEQ_MODEL ?? "jev-latest",
    state,
    questions: {
      routing: { type: "choice", instructions: QUESTION_INSTRUCTIONS, criteria: RULE_CRITERIA },
    },
  });
}

async function askJev(state: RoutingState, requestFile: string): Promise<{ answer?: RoutingAnswer; confidence?: number; raw: string }> {
  await fs.writeFile(requestFile, buildRoutingRequest(state));
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
    const parsed = JSON.parse(stdout) as { answers?: { routing?: { choice?: string; confidence?: number } } };
    const choice = parsed.answers?.routing?.choice;
    return { answer: parseRouteAnswer(choice), confidence: parsed.answers?.routing?.confidence, raw: stdout.trim() };
  } catch (error) {
    return { raw: String((error as Error).message).slice(0, 200) };
  } finally {
    void started;
  }
}

/** Runs one jeq call per case and records status/answer/confidence/latency. */
async function evaluateWithJev(eligible: readonly LabeledFailure[], states: ReadonlyMap<string, RoutingState>, args: Args): Promise<JevRouteResult[]> {
  const requestDir = path.join(args.out, "requests");
  await fs.mkdir(requestDir, { recursive: true });
  const results: JevRouteResult[] = [];

  for (const [index, evaluationCase] of eligible.slice(0, args.budget).entries()) {
    const state = states.get(evaluationCase.caseId);
    if (!state) continue;
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}-${evaluationCase.caseId}.json`);
    const started = Date.now();
    const { answer, confidence, raw } = await askJev(state, requestFile);
    const latencyMs = Date.now() - started;
    const status = answer !== undefined ? "answered" : raw.length === 0 ? "failed" : confidence === undefined ? "malformed" : "abstain";
    results.push({ caseId: evaluationCase.caseId, status, ...(answer === undefined ? {} : { answer }), ...(confidence === undefined ? {} : { confidence }), latencyMs });
  }
  return results;
}

function renderMarkdown(metrics: ReturnType<typeof evaluateRouting>, decision: { decision: string; reason: string }, rows: readonly { caseId: string; label: RoutingLabel; baseline?: string; jev?: string; confidence?: number }[]): string {
  const lines = [
    "# TASK-0021 — offline routing evaluation",
    "",
    "Direction evidence only. Offline; no runtime integration.",
    "",
    "## Metrics",
    "",
    `- cases: ${metrics.cases}; labeled unresolved: ${metrics.labeledUnresolved}`,
    `- deterministic coverage: ${metrics.deterministicCovered}/${metrics.cases} (${(metrics.deterministicCoverage * 100).toFixed(1)}%), precision ${metrics.deterministicPrecision.toFixed(3)}`,
    `- Jev eligible: ${metrics.jevEligible}; attempted ${metrics.jevAttempted}; abstained ${metrics.jevAbstained}; malformed ${metrics.jevMalformed}; failed ${metrics.jevFailed}`,
    `- Jev precision: ${metrics.jevPrecision.toFixed(3)}; precision@${ROUTING_POLICY.confidenceThreshold}: ${metrics.jevPrecisionAtThreshold.toFixed(3)} over ${metrics.jevHighConfidenceAttempted} high-confidence attempts`,
    `- automatic actions at threshold: wrong ${metrics.jevHighConfidenceWrong} (mutating ${metrics.jevHighConfidenceUnsafeWrong}) — zero required`,
    `- below-threshold wrong (disclosed calibration evidence, never actioned): ${metrics.jevBelowThresholdWrong}; overall wrong: ${metrics.jevWrong}; unsafe predictions: ${metrics.jevUnsafeWrong}`,
    `- marginal Jev coverage: ${metrics.marginalCoverage}`,
    `- latency: ${metrics.latencyMs} ms total`,
    "",
    "## Recommendation: " + decision.decision,
    "",
    decision.reason,
    "",
    "## Cases",
    "",
    "| case | label | deterministic | jev | confidence |",
    "|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(`| ${row.caseId} | ${row.label} | ${row.baseline ?? "—"} | ${row.jev ?? "—"} | ${row.confidence?.toFixed(2) ?? "—"} |`);
  }
  return lines.join("\n") + "\n";
}

async function commandRun(args: Args): Promise<void> {
  const states = new Map<string, RoutingState>();
  for (const evaluationCase of LABELED_FAILURES) {
    const state = buildRoutingState(evaluationCase);
    if (state) states.set(evaluationCase.caseId, state);
  }

  // Deterministic veto/baseline first: only unresolved cases reach Jev.
  const eligible = LABELED_FAILURES.filter((evaluationCase) => {
    const state = states.get(evaluationCase.caseId);
    return state !== undefined && deterministicRoute(state) === undefined;
  });

  const jevResults = await evaluateWithJev(eligible, states, args);
  const metrics = evaluateRouting(LABELED_FAILURES, states, jevResults);
  const decision = decideRouting(metrics);

  const jevByCase = new Map(jevResults.map((result) => [result.caseId, result]));
  const rows = LABELED_FAILURES.map((evaluationCase) => {
    const state = states.get(evaluationCase.caseId);
    const baseline = state ? deterministicRoute(state) : undefined;
    const jev = jevByCase.get(evaluationCase.caseId);
    return {
      caseId: evaluationCase.caseId,
      label: evaluationCase.label,
      ...(baseline === undefined ? {} : { baseline }),
      ...(jev?.answer === undefined ? {} : { jev: jev.answer }),
      ...(jev?.confidence === undefined ? {} : { confidence: jev.confidence }),
    };
  });

  await fs.mkdir(args.out, { recursive: true });
  const report = { label: "direction evidence only", policy: ROUTING_POLICY, metrics, recommendation: decision, rows, jevResults };
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(args.out, "report.md"), renderMarkdown(metrics, decision, rows));
  console.log(JSON.stringify({ metrics, recommendation: decision }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
