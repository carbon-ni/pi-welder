#!/usr/bin/env node
/**
 * TASK-0020 offline label tooling. Deterministic: same inputs -> same worksheet.
 *
 * Usage (run from the pi-welder extension directory):
 *
 *   1) Emit a review worksheet from welder logs + session transcripts:
 *        node --experimental-strip-types scripts/shadow-labels.ts worksheet \
 *          [--logs <welder-log-dir> ...] [--sessions <sessions-dir>] [--out <file>]
 *      Defaults: --sessions ~/.pi/agent/sessions, logs auto-discovered from each
 *      transcript's recorded cwd (<cwd>/.pi/welder-log), output .tmp/shadow-labels/worksheet.tsv
 *
 *   2) After the reviewer fills the `verified-target` column (ordinal or
 *      "unresolvable"), compute the predeclared metrics:
 *        node --experimental-strip-types scripts/shadow-labels.ts metrics [--worksheet <file>]
 *
 * Privacy: only shadow metadata (opaque ids, counts, ordinals, statuses) is
 * read or written. Source windows, edit text, and paths are never printed or
 * persisted. All artifacts stay under .tmp/ (git-ignored).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  buildWorksheet,
  computeMetrics,
  linkTranscript,
  parseShadowEvent,
  parseWorksheet,
  type ShadowRow,
} from "../src/model-recovery/shadow-labels.ts";

interface Args {
  logs: string[];
  sessions: string;
  out: string;
  worksheet: string;
  command: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    logs: [],
    sessions: path.join(homedir(), ".pi", "agent", "sessions"),
    out: path.join(".tmp", "shadow-labels", "worksheet.tsv"),
    worksheet: path.join(".tmp", "shadow-labels", "worksheet.tsv"),
    command: argv[0] ?? "worksheet",
  };
  for (let index = 1; index < argv.length; index += 2) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--logs": args.logs.push(value ?? ""); break;
      case "--sessions": args.sessions = value ?? args.sessions; break;
      case "--out": args.out = value ?? args.out; break;
      case "--worksheet": args.worksheet = value ?? args.worksheet; break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function readShadowRows(logPath: string): Promise<ShadowRow[]> {
  const text = await readFile(logPath, "utf8");
  const rows: ShadowRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = parseShadowEvent(JSON.parse(line));
      if (row) rows.push({ ...row, sessionId: row.sessionId || path.basename(logPath, ".jsonl") });
    } catch { /* malformed line: skip deterministically */ }
  }
  return rows;
}

interface TranscriptSummary { sessionId: string; cwd?: string; editCallIds: string[] }

async function readTranscript(filePath: string): Promise<TranscriptSummary | undefined> {
  const text = await readFile(filePath, "utf8");
  const summary: TranscriptSummary = { sessionId: "", editCallIds: [] };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session" && typeof entry.id === "string") summary.sessionId = entry.id;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "edit" && typeof block.id === "string") {
          summary.editCallIds.push(block.id);
        }
      }
    }
  }
  return summary.sessionId ? summary : undefined;
}

/** Discovers welder logs from each transcript's recorded cwd (deterministic order). */
async function discoverLogFiles(sessionsDir: string): Promise<string[]> {
  const discovered = new Set<string>();
  const dirs = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await readdir(dirPath)).filter((name) => name.endsWith(".jsonl")).sort()) {
      const filePath = path.join(dirPath, file);
      try {
        const firstLine = (await readFile(filePath, "utf8")).split("\n", 1)[0] ?? "";
        const cwd = JSON.parse(firstLine)?.cwd;
        if (typeof cwd === "string") discovered.add(path.join(cwd, ".pi", "welder-log"));
      } catch { /* skip unreadable transcripts */ }
    }
  }
  return [...discovered];
}

async function collectTranscripts(sessionsDir: string): Promise<TranscriptSummary[]> {
  const summaries: TranscriptSummary[] = [];
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await readdir(dirPath)).filter((name) => name.endsWith(".jsonl")).sort()) {
      const summary = await readTranscript(path.join(dirPath, file)).catch(() => undefined);
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

async function commandWorksheet(args: Args): Promise<void> {
  const logDirs = args.logs.length > 0 ? args.logs : await discoverLogFiles(args.sessions);
  const rows: ShadowRow[] = [];
  for (const dir of logDirs) {
    for (const file of await listJsonlFiles(dir)) {
      rows.push(...await readShadowRows(file));
    }
  }
  const transcripts = await collectTranscripts(args.sessions);
  const linked = rows.filter((row) => linkTranscript(transcripts, row).callLinked);
  const worksheet = buildWorksheet(rows);
  await mkdir(path.parse(args.out).dir, { recursive: true });
  await writeFile(args.out, worksheet);
  console.log(`wrote ${args.out}`);
  console.log(`shadow rows: ${rows.length}; transcript-linked edit calls: ${linked.length}`);
}

async function commandMetrics(args: Args): Promise<void> {
  const rows = parseWorksheet(await readFile(args.worksheet, "utf8"));
  const metrics = computeMetrics(rows);
  const verdict = metrics.reviewedAttempted < 30
    ? "insufficient-collection (<30 reviewed attempted labels)"
    : metrics.wrongTarget > 0
      ? "REJECT: wrong-target is a hard-safety violation"
      : (metrics.precision ?? 0) >= 0.99
        ? "candidates meet precision gate; owner review required"
        : "precision below 0.99 gate";
  console.log(JSON.stringify({ ...metrics, verdict }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "worksheet") await commandWorksheet(args);
else if (args.command === "metrics") await commandMetrics(args);
else throw new Error(`Unknown command ${args.command} (use: worksheet | metrics)`);
