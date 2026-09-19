#!/usr/bin/env node
/**
 * TASK-0027 historical shadow observability. Deterministic: same input logs
 * produce byte-identical output.
 *
 * Usage (run from the pi-welder extension directory):
 *
 *   node --experimental-strip-types scripts/shadow-stats.ts stats \
 *     [--logs <welder-log-dir> ...] [--sessions <sessions-dir>] [--out <file>] [--json]
 *
 * Defaults: logs auto-discovered from each transcript's recorded cwd
 * (<cwd>/.pi/welder-log); output .tmp/shadow-stats/report.txt (or .json).
 *
 * Privacy: reads and emits closed shadow metadata only (statuses, counts,
 * confidence, latency, labels). Source windows, paths, edit text, credentials,
 * and provider payloads are never read into the report or emitted.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { readEvents } from "../src/recorder/log.ts";
import { aggregateShadowStats, fromShadowEvent, renderShadowStats, type ShadowRecord } from "../src/model-recovery/shadow-stats.ts";

interface Args {
  command: string;
  logs: string[];
  sessions: string;
  out: string;
  json: boolean;
}

const DEFAULT_OUT = ".tmp/shadow-stats/report.txt";

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "stats",
    logs: [],
    sessions: path.join(homedir(), ".pi", "agent", "sessions"),
    out: DEFAULT_OUT,
    json: false,
  };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--logs": args.logs.push(requireValue(argv, index++)); break;
      case "--sessions": args.sessions = requireValue(argv, index++); break;
      case "--out": args.out = requireValue(argv, index++); break;
      case "--json": args.json = true; break;
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

/** Discovers welder logs from each transcript's recorded cwd (deterministic order). */
async function discoverLogFiles(sessionsDir: string): Promise<string[]> {
  const discovered = new Set<string>();
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      try {
        const firstLine = (await readFile(path.join(dirPath, file), "utf8")).split("\n", 1)[0] ?? "";
        const cwd = JSON.parse(firstLine)?.cwd;
        if (typeof cwd === "string") discovered.add(path.join(cwd, ".pi", "welder-log"));
      } catch { /* skip unreadable transcripts */ }
    }
  }
  return [...discovered].sort();
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(dir, name));
}

async function collectShadowRecords(logDirs: readonly string[]): Promise<{ records: ShadowRecord[]; files: number }> {
  const records: ShadowRecord[] = [];
  const files: string[] = [];
  for (const dir of logDirs) {
    for (const file of await listJsonlFiles(dir)) {
      files.push(file);
      for (const event of await readEvents(file)) {
        const record = fromShadowEvent(event as unknown as Record<string, unknown>);
        if (record) records.push(record);
      }
    }
  }
  return { records, files: files.length };
}

async function commandStats(args: Args): Promise<void> {
  const logDirs = args.logs.length > 0 ? args.logs : await discoverLogFiles(args.sessions);
  const { records, files } = await collectShadowRecords(logDirs);
  // Historical logs carry completed events only: submitted is unknowable and is
  // reported as n/a rather than invented from completed counts.
  const stats = aggregateShadowStats(records, undefined);

  const output = args.json ? JSON.stringify(stats, null, 2) + "\n" : renderShadowStats(stats);
  await mkdir(path.parse(args.out).dir, { recursive: true });
  await writeFile(args.out, output);
  process.stdout.write(output);
  process.stderr.write(`logs=${logDirs.length} files=${files} shadowEvents=${records.length} out=${args.out}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "stats") await commandStats(args);
else throw new Error(`Unknown command ${args.command} (use: stats)`);
