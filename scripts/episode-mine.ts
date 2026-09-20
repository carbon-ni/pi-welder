#!/usr/bin/env node
/**
 * TASK-0030 — mine bounded failure-and-recovery episodes from sessions.
 *
 * Local and offline only: NO jeq/LLM/API calls, no runtime changes. The shared
 * report is metadata-only. Full episode content is written exclusively to an
 * ignored `.tmp` review worksheet.
 *
 * Usage (from the pi-welder extension directory):
 *   node --experimental-strip-types scripts/episode-mine.ts run [--sessions <dir>] [--out <dir>] [--top <n>] [--per-family <n>]
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { mineEpisodes, type MiningEvent } from "../src/mining/episode.ts";
import { buildMiningReport, renderMiningReport, renderWorksheet } from "../src/mining/report.ts";

const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_OUT = ".tmp/episode-mine";

interface Args { command: string; sessions: string; out: string; top: number; perFamily: number }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "run", sessions: DEFAULT_SESSIONS, out: DEFAULT_OUT, top: 5, perFamily: 2 };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--sessions": args.sessions = argv[++index] ?? args.sessions; break;
      case "--out": args.out = argv[++index] ?? args.out; break;
      case "--top": args.top = Number(argv[++index] ?? args.top); break;
      case "--per-family": args.perFamily = Number(argv[++index] ?? args.perFamily); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function argShape(input: Record<string, unknown>): { argKeys: string[]; argTypes: Record<string, string> } {
  const argKeys = Object.keys(input).sort();
  const argTypes: Record<string, string> = {};
  for (const key of argKeys) argTypes[key] = valueType(input[key]);
  return { argKeys, argTypes };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

/** Normalizes one transcript into ordered mining events (content stays in memory). */
async function readSession(filePath: string): Promise<{ sessionId: string; events: MiningEvent[] } | undefined> {
  const text = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let sessionId = "";
  const events: MiningEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      continue;
    }
    const message = entry.message;
    if (!message || typeof entry.timestamp !== "string") continue;

    if (message.role === "user" || message.role === "assistant") {
      const toolCalls = (Array.isArray(message.content) ? message.content : []).filter((block: any) => block?.type === "toolCall");
      const textContent = textOf(message.content);
      // Preserve assistant text even when the same message also calls tools.
      if (textContent) {
        events.push({ id: `${entry.id ?? events.length}:text`, ts: entry.timestamp, kind: message.role === "user" ? "user" : "assistant", contentText: textContent });
      }
      if (toolCalls.length === 0) continue;
      for (const block of toolCalls) {
        const input = (block.arguments ?? {}) as Record<string, unknown>;
        const { argKeys, argTypes } = argShape(input);
        const editLocator = Array.isArray(input.edits)
          ? (input.edits as any[]).map((edit) => (typeof edit?.oldText === "string" ? edit.oldText : "")).filter(Boolean).join("\n---\n")
          : undefined;
        events.push({
          id: `${block.id}`,
          ts: entry.timestamp,
          kind: "toolCall",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolCallId: typeof block.id === "string" ? block.id : undefined,
          argKeys,
          argTypes,
          ...(typeof input.path === "string" ? { path: input.path } : {}),
          ...(editLocator ? { editLocator } : {}),
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const contentText = textOf(message.content);
      events.push({
        id: `${message.toolCallId ?? events.length}`,
        ts: entry.timestamp,
        kind: "toolResult",
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        ...(contentText ? { errorText: contentText, contentText } : {}),
      });
    }
  }
  return sessionId ? { sessionId, events } : undefined;
}

async function collectEpisodes(sessionsDir: string): Promise<{ sessions: number; episodes: ReturnType<typeof mineEpisodes> }> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  let sessions = 0;
  const episodes: ReturnType<typeof mineEpisodes> = [];
  for (const dir of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dirPath = path.join(sessionsDir, dir.name);
    for (const file of (await fs.readdir(dirPath).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort()) {
      const session = await readSession(path.join(dirPath, file));
      if (!session) continue;
      sessions++;
      episodes.push(...mineEpisodes(session.sessionId, session.events));
    }
  }
  return { sessions, episodes };
}

async function commandRun(args: Args): Promise<void> {
  const { sessions, episodes } = await collectEpisodes(args.sessions);
  const report = buildMiningReport(episodes, { topFamilies: args.top, perFamily: args.perFamily });

  await fs.mkdir(args.out, { recursive: true });
  const markdown = renderMiningReport(report);
  await fs.writeFile(path.join(args.out, "report.md"), markdown);
  await fs.writeFile(path.join(args.out, "index.json"), JSON.stringify({ sessions, ...report }, null, 2) + "\n");
  await fs.writeFile(path.join(args.out, "worksheet.tsv"), renderWorksheet(episodes));

  console.log(JSON.stringify({
    sessions,
    episodes: report.episodes,
    families: report.byFamily.length,
    shapes: report.byShape.filter((entry) => entry.count > 0),
    topFamily: report.byFamily[0]?.family ?? null,
    sessionConcentration: { max: report.sessionConcentration.max, median: report.sessionConcentration.median, sessions: report.sessionConcentration.sessions },
    artifacts: { report: path.join(args.out, "report.md"), index: path.join(args.out, "index.json"), worksheet: path.join(args.out, "worksheet.tsv") },
    apiCalls: 0,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "run") await commandRun(args);
else throw new Error(`Unknown command ${args.command} (use: run)`);
