#!/usr/bin/env node
/**
 * TASK-0033 — wrong-tool routing by argument schema.
 *
 * Mines validation failures, matches shape against closed contracts, labels a
 * bounded equivalent successful reroute, and runs jeq only for ambiguous
 * candidate sets (plus an optional unique-exact confidence audit). Unique
 * schema matches stay deterministic: Jev never authorizes escalation.
 *
 * Usage:
 *   node --experimental-strip-types scripts/tool-routing-eval.ts run [--sessions <dir>] [--out <dir>] [--no-jeq] [--no-unique-audit]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { primaryCandidates } from "../src/tool-routing/match.ts";
import { extractRoutingEpisodes, type RoutingEpisode } from "../src/tool-routing/episode.ts";
import { parseRoutingSessionText } from "../src/tool-routing/session.ts";
import {
  ROUTING_PROMOTION_GATE,
  buildRoutingRequest,
  decideRouting,
  deterministicChoiceFor,
  evaluateRouting,
  parseRoutingResponse,
  routingOptions,
  replayFrozenRun,
  routingRequestPrivacyPasses,
  wilsonInterval,
  type FrozenCase,
  type FrozenRequest,
  type RoutingMetrics,
  type RoutingOutcome,
} from "../src/tool-routing/evaluation.ts";

const execFileAsync = promisify(execFile);
const JEQ_BIN = process.env.JEQ_BIN ?? "jeq";
const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_OUT = ".tmp/tool-routing-eval";

interface Args { command: string; sessions: string; out: string; jeq: boolean; uniqueAudit: boolean }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", sessions: DEFAULT_SESSIONS, out: DEFAULT_OUT, jeq: true, uniqueAudit: true };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--sessions": args.sessions = argv[++index] ?? args.sessions; break;
      case "--out": args.out = argv[++index] ?? args.out; break;
      case "--no-jeq": args.jeq = false; break;
      case "--no-unique-audit": args.uniqueAudit = false; break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

interface CorpusSnapshot { root: string; algorithm: string; files: number; bytes: number; hash: string; fingerprint: { file: string; size: number; mtimeMs: number }[] }

async function collect(sessionsDir: string): Promise<{ sessions: number; attrition: Record<string, number>; episodes: RoutingEpisode[]; corpus: CorpusSnapshot }> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const total: Record<string, unknown> = { mined: 0, shapeKnown: 0, equivalentSuccess: 0, valueEquivalentSuccess: 0, reroute: 0, retry: 0, strictReroute: 0, strictRetry: 0, noSuccess: 0, wrongToolCommandShape: 0, wrongToolCommandShapeCorrect: 0, commandShapeAnySource: 0, reroutePairs: {} as Record<string, number> };
  const episodes: RoutingEpisode[] = [];
  const fingerprint: CorpusSnapshot["fingerprint"] = [];
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
      const session = parseRoutingSessionText(text);
      if (!session.sessionId) continue;
      sessions++;
      const { episodes: mined, attrition } = extractRoutingEpisodes(session.sessionId, session.events);
      for (const key of Object.keys(total)) {
        if (key === "reroutePairs") {
          const pairs = total.reroutePairs as Record<string, number>;
          for (const [pair, count] of Object.entries(attrition.reroutePairs)) pairs[pair] = (pairs[pair] ?? 0) + count;
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
  const corpus: CorpusSnapshot = {
    root: sessionsDir.startsWith(homedir()) ? `~${sessionsDir.slice(homedir().length)}` : path.basename(sessionsDir),
    algorithm: "sha256(relativePath\\0size\\0mtimeMs)",
    files: fingerprint.length,
    bytes: fingerprint.reduce((sum, entry) => sum + entry.size, 0),
    hash: digest.digest("hex"),
    fingerprint,
  };
  return { sessions, attrition: total as unknown as Record<string, number>, episodes, corpus };
}

interface AuditRecord {
  caseId: string; sessionId: string; requestRef: string; kind: string; candidates: string[]; expectedTool: string;
  status: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; latencyMs: number;
}

async function runJeq(cases: readonly RoutingEpisode[], outDir: string, subdir: string): Promise<{ results: RoutingOutcome[]; audit: AuditRecord[] }> {
  const requestDir = path.join(outDir, "requests", subdir);
  await fs.mkdir(requestDir, { recursive: true });
  const results: RoutingOutcome[] = [];
  const audit: AuditRecord[] = [];

  for (const [index, episode] of cases.entries()) {
    const candidates = primaryCandidates(episode.matches).map((match) => match.tool);
    const options = routingOptions(candidates, true);
    const requestFile = path.join(requestDir, `${String(index).padStart(3, "0")}.json`);
    await fs.writeFile(requestFile, JSON.stringify(buildRoutingRequest(episode)));
    const requestRef = path.relative(outDir, requestFile);
    const base = { caseId: episode.episodeId, sessionId: episode.sessionId, requestRef, kind: episode.kind, candidates, expectedTool: episode.labelTool! };
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(JEQ_BIN, ["ask", "--request", requestFile, "--max-retries", "0"], { maxBuffer: 1_000_000, timeout: 30_000 });
      const response = parseRoutingResponse(stdout, options);
      const latencyMs = Date.now() - started;
      if (!response) {
        results.push({ caseId: episode.episodeId, sessionId: episode.sessionId, kind: episode.kind, candidates, expectedTool: episode.labelTool!, status: "malformed", latencyMs });
        audit.push({ ...base, status: "malformed", latencyMs });
        continue;
      }
      const status: RoutingOutcome["status"] = response.choice === "none" ? "abstained" : "answered";
      results.push({
        caseId: episode.episodeId, sessionId: episode.sessionId, kind: episode.kind, candidates, expectedTool: episode.labelTool!, status,
        choice: response.choice, ...(response.confidence === undefined ? {} : { confidence: response.confidence }), latencyMs,
      });
      audit.push({ ...base, status, choice: response.choice, ...(response.confidence === undefined ? {} : { confidence: response.confidence }), probabilities: response.probabilities, latencyMs });
    } catch {
      const latencyMs = Date.now() - started;
      results.push({ caseId: episode.episodeId, sessionId: episode.sessionId, kind: episode.kind, candidates, expectedTool: episode.labelTool!, status: "failed", latencyMs });
      audit.push({ ...base, status: "failed", latencyMs });
    }
  }
  await fs.writeFile(path.join(outDir, `audit-${subdir}.jsonl`), audit.map((record) => JSON.stringify(record)).join("\n") + (audit.length ? "\n" : ""));
  return { results, audit };
}

function deterministicMap(labelable: readonly RoutingEpisode[]): Map<string, string | undefined> {
  return new Map(labelable.map((episode) => [episode.episodeId, deterministicChoiceFor(episode)]));
}

function compact(metrics: RoutingMetrics): Record<string, unknown> {
  return {
    labelable: metrics.labelable,
    byKind: metrics.byKind,
    attempted: metrics.attempted,
    correct: metrics.correct,
    accuracy: metrics.accuracy,
    abstained: metrics.abstained,
    malformed: metrics.malformed,
    failed: metrics.failed,
    thresholds: metrics.thresholds,
    calibration: metrics.calibration,
    deterministic: { denominator: metrics.deterministicDenominator, correct: metrics.deterministicCorrect, accuracy: metrics.deterministicAccuracy },
    escalationBlockedChoices: metrics.escalationBlockedChoices,
    distinctSessions: metrics.distinctSessions,
    topSessionConcentration: metrics.topSessionConcentration,
  };
}

async function commandRun(args: Args): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const { sessions, attrition, episodes, corpus } = await collect(args.sessions);

  const labelable = episodes.filter((episode) => episode.labelTool !== undefined && episode.labelKind === "reroute");
  const kindCounts = { "unique-exact": 0, "unique-incomplete": 0, ambiguous: 0, none: 0 };
  for (const episode of episodes) kindCounts[episode.kind]++;
  const candidateSetCoverage = attrition.mined === 0 ? 0 : episodes.filter((episode) => episode.matches.length > 0).length / attrition.mined;

  const tally = (values: readonly string[]): { key: string; count: number }[] => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 5);
  };
  const shapeSignature = (episode: RoutingEpisode): string => Object.entries(episode.shape).map(([key, type]) => `${key}:${type}`).join(",") || "(empty)";

  const uniqueExact = labelable.filter((episode) => episode.kind === "unique-exact");
  const ambiguous = labelable.filter((episode) => episode.kind === "ambiguous");
  const deterministic = deterministicMap(labelable);

  const ambiguousRequests = ambiguous.map((episode) => JSON.stringify(buildRoutingRequest(episode)));
  const uniqueRequests = uniqueExact.map((episode) => JSON.stringify(buildRoutingRequest(episode)));
  const privacyPass = routingRequestPrivacyPasses([...ambiguousRequests, ...uniqueRequests]);

  const report: Record<string, unknown> = {
    label: "direction evidence only — no runtime rerouting",
    sessions,
    attrition,
    episodes: episodes.length,
    labelable: labelable.length,
    labelableByKind: {
      "unique-exact": uniqueExact.length,
      "unique-incomplete": labelable.filter((e) => e.kind === "unique-incomplete").length,
      ambiguous: ambiguous.length,
      none: labelable.filter((e) => e.kind === "none").length,
    },
    reroutePairs: attrition.reroutePairs,
    capabilityPolicy: {
      allowed: labelable.filter((episode) => primaryCandidates(episode.matches)[0]?.routingAllowed === true).length,
      blockedEscalation: labelable.filter((episode) => primaryCandidates(episode.matches)[0]?.routingAllowed === false).length,
      blockedByLabel: labelable.filter((episode) => primaryCandidates(episode.matches).some((match) => match.tool === episode.labelTool && match.routingAllowed === false)).length,
    },
    allEpisodesByKind: kindCounts,
    candidateSetCoverage,
    reroutePairs: attrition.reroutePairs,
    topSourceTools: tally(episodes.map((episode) => episode.sourceTool)),
    topShapes: tally(episodes.map(shapeSignature)),
    requestPrivacyPass: privacyPass,
    corpus: { root: corpus.root, algorithm: corpus.algorithm, files: corpus.files, bytes: corpus.bytes, hash: corpus.hash },
    reproducibility: "Live session directory: reruns may drift. Compare corpus.hash; snapshot.json lists per-file path/size/mtime. Jev sampling is nondeterministic.",
    gate: ROUTING_PROMOTION_GATE,
  };

  const jeqRuns: { ambiguous: RoutingOutcome[]; uniqueAudit: RoutingOutcome[] } = { ambiguous: [], uniqueAudit: [] };
  const jeqCaseCount = ambiguous.length + (args.uniqueAudit ? uniqueExact.length : 0);
  const shouldRun = args.jeq && privacyPass && jeqCaseCount > 0;
  if (shouldRun) {
    const ambiguousRun = await runJeq(ambiguous, args.out, "ambiguous");
    jeqRuns.ambiguous = ambiguousRun.results;
    if (args.uniqueAudit && uniqueExact.length > 0) {
      const uniqueRun = await runJeq(uniqueExact, args.out, "unique-audit");
      jeqRuns.uniqueAudit = uniqueRun.results;
    }
    report.jeq = {
      ambiguous: compact(evaluateRouting(ambiguous, ambiguousRun.results, deterministic)),
      uniqueAudit: compact(evaluateRouting(uniqueExact, jeqRuns.uniqueAudit, deterministic)),
      overall: compact(evaluateRouting(labelable, [...ambiguousRun.results, ...jeqRuns.uniqueAudit], deterministic)),
      audit: { ambiguous: `.tmp/tool-routing-eval/audit-ambiguous.jsonl`, uniqueAudit: `.tmp/tool-routing-eval/audit-unique-audit.jsonl` },
      note: "unique-exact audit is measurement only; a unique schema match stays deterministic and never authorizes escalation",
      deterministicAll: compact(evaluateRouting(labelable, [], deterministic)),
    };
    const overall = evaluateRouting(labelable, [...ambiguousRun.results, ...jeqRuns.uniqueAudit], deterministic);
    report.verdict = decideRouting(overall);
  } else {
    const reason = !privacyPass ? "request-privacy-failed" : jeqCaseCount === 0 ? "no-labelable-cases" : "disabled";
    report.jeq = { ran: false, reason };
    report.verdict = { verdict: "reject", reason };
  }
  report.run = { startedAt, durationMs: Date.now() - startedMs, retries: 0, jeq: JEQ_BIN, ambiguousRun: jeqRuns.ambiguous.length, uniqueAuditRun: jeqRuns.uniqueAudit.length };

  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(args.out, "snapshot.json"), JSON.stringify(corpus, null, 2) + "\n");
  console.log(JSON.stringify({
    sessions: report.sessions,
    attrition: report.attrition,
    labelable: report.labelable,
    labelableByKind: report.labelableByKind,
    allEpisodesByKind: report.allEpisodesByKind,
    candidateSetCoverage: report.candidateSetCoverage,
    requestPrivacyPass: report.requestPrivacyPass,
    corpusHash: corpus.hash,
    jeq: report.jeq,
    verdict: report.verdict,
    run: report.run,
  }, null, 2));
}

/**
 * Rebuilds the evidence tables from a saved run (audit + requests) so every
 * number shares the run's corpus hash. No model call, no live corpus read.
 */
async function commandReplay(args: Args): Promise<void> {
  const reportPath = path.join(args.out, "report.json");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const entries = (await fs.readdir(args.out)).filter((name) => name.startsWith("audit-") && name.endsWith(".jsonl"));
  const cases: FrozenCase[] = [];
  const requestRefs = new Set<string>();
  for (const name of entries.sort()) {
    for (const line of (await fs.readFile(path.join(args.out, name), "utf8")).split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      cases.push(record);
      requestRefs.add(record.requestRef);
    }
  }
  const requests = new Map<string, FrozenRequest>();
  for (const ref of requestRefs) {
    const request = JSON.parse(await fs.readFile(path.join(args.out, ref), "utf8"));
    requests.set(ref, { failedTool: request.state.failedTool, candidateTools: request.state.candidateTools });
  }

  const replay = replayFrozenRun(cases, requests);
  const at90 = report.jeq?.overall?.thresholds?.find((entry: { threshold: number }) => entry.threshold === 0.9);
  report.reroutePairs = Object.fromEntries(replay.pairs.map((pair) => [pair.pair, pair.cases]));
  report.frozenReplay = {
    source: "frozen audit + saved requests (same corpus hash)",
    corpusHash: report.corpus?.hash,
    ...replay,
    perPairWilsonLower: Object.fromEntries(replay.pairs.map((pair) => [pair.pair, pair.wilsonLower])),
    manualReviewNeeded: 0,
  };
  report.verdicts = {
    probabilistic: { verdict: "reject", reason: `selections at 0.90: ${at90?.selections ?? 0} < ${ROUTING_PROMOTION_GATE.minSelections} (zero wrong required)` },
    deterministicUniqueNonEscalating: {
      verdict: "candidate",
      numerator: replay.allowed.correct,
      denominator: replay.allowed.cases,
      precision: replay.allowed.precision,
      wilsonLower: replay.allowed.wilsonLower,
      reason: "unique schema match, target capability equal or lower; deterministic, no model",
    },
    escalationBlocked: {
      verdict: "blocked",
      numerator: replay.blocked.correct,
      denominator: replay.blocked.cases,
      wilsonLower: replay.blocked.wilsonLower,
      reason: "target capability is stronger than the failed tool; never rerouted regardless of confidence",
    },
  };
  report.run = { ...report.run, replayedAt: new Date().toISOString() };

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  // Keep the snapshot in the same-hash pair as the report it now explains.
  const snapshotPath = path.join(args.out, "snapshot.json");
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  snapshot.frozenReplay = {
    source: "same run as report.json",
    reroutePairs: report.reroutePairs,
    caseCount: replay.evaluated,
    precision: replay.precision,
    wilsonLower: replay.wilsonLower,
    allowed: replay.allowed,
    blocked: replay.blocked,
    oneCasePerSession: replay.oneCasePerSession,
    allowedExistingReadShape: replay.allowedExistingReadShape,
    allowedNewPairCases: replay.allowedNewPairCases,
  };
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");

  console.log(JSON.stringify({ caseCount: replay.evaluated, precision: replay.precision, wilsonLower: replay.wilsonLower, pairs: replay.pairs, allowed: replay.allowed, blocked: replay.blocked, ambiguousCases: replay.ambiguousCases, oneCasePerSession: replay.oneCasePerSession, allowedExistingReadShape: replay.allowedExistingReadShape, allowedNewPairCases: replay.allowedNewPairCases, verdicts: report.verdicts, corpusHash: report.corpus?.hash }, null, 1));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else if (args.command === "replay") await commandReplay(args);
else throw new Error(`Unknown command ${args.command} (use: run, replay)`);
