/**
 * Observability — in-memory stats + append-only JSONL event log.
 *
 * Stats are pure counters (no I/O). The log is one JSON object per line at
 * `.pi/welder-log/<sessionId>.jsonl`, pruneable to a bounded retention.
 * Schema is intentionally lean: enough to answer "what does this model get
 * wrong?" without burdening disk or the LLM context.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Repair } from "./repairs.ts";

export type { Repair } from "./repairs.ts";

export interface WelderEvent {
  ts: string;
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: string[];
  wasRepaired: boolean;
  inputKeys: string[];
  wasError?: boolean;
  errorKind?: string;
  errorText?: string;
}

export interface Stats {
  totalToolCalls: number;
  repairedToolCalls: number;
  failedToolResults: number;
  failuresByTool: Map<string, number>;
  repairsByAction: Map<string, number>;
  sessionId: string | null;
}

/** Fresh per-session counters. */
export function createStats(): Stats {
  return {
    totalToolCalls: 0,
    repairedToolCalls: 0,
    failedToolResults: 0,
    failuresByTool: new Map(),
    repairsByAction: new Map(),
    sessionId: null,
  };
}

/** Fold a list of repairs for one tool call into session stats. */
export function recordRepairs(stats: Stats, repairs: Repair[]): void {
  if (repairs.length === 0) return;
  stats.repairedToolCalls += 1;
  for (const r of repairs) {
    stats.repairsByAction.set(r.action, (stats.repairsByAction.get(r.action) ?? 0) + 1);
  }
}

export function recordToolFailure(stats: Stats, toolName: string): void {
  stats.failedToolResults += 1;
  stats.failuresByTool.set(toolName, (stats.failuresByTool.get(toolName) ?? 0) + 1);
}

interface BuildEventInput {
  eventType: "tool_call" | "tool_result";
  toolName: string;
  provider: string;
  model: string;
  repairs: Repair[];
  inputKeys: string[];
}

interface BuildToolResultEventInput {
  toolName: string;
  provider: string;
  model: string;
  inputKeys: string[];
  errorText: string;
}

/** Assemble an event from inputs (ts stamped at call time). */
export function buildEvent(input: BuildEventInput): WelderEvent {
  return {
    ts: new Date().toISOString(),
    eventType: input.eventType,
    toolName: input.toolName,
    provider: input.provider,
    model: input.model,
    repairs: input.repairs.map((r) => r.action),
    wasRepaired: input.repairs.length > 0,
    inputKeys: input.inputKeys,
  };
}

export function buildToolResultEvent(input: BuildToolResultEventInput): WelderEvent {
  return {
    ts: new Date().toISOString(),
    eventType: "tool_result",
    toolName: input.toolName,
    provider: input.provider,
    model: input.model,
    repairs: [],
    wasRepaired: false,
    inputKeys: input.inputKeys,
    wasError: true,
    errorKind: classifyErrorKind(input.errorText),
    errorText: truncate(input.errorText, 500),
  };
}

/** Path of one session's log file. */
export function sessionLogPath(logDir: string, sessionId: string): string {
  return path.join(logDir, `${sessionId}.jsonl`);
}

/** Append one event as a JSON line. Creates the directory if needed. */
export async function appendEvent(logDir: string, sessionId: string, event: WelderEvent): Promise<void> {
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(sessionLogPath(logDir, sessionId), JSON.stringify(event) + "\n", "utf8");
}

/** Read all events from a session log file; tolerates blank/malformed lines. */
export async function readEvents(sessionFile: string): Promise<WelderEvent[]> {
  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf8");
  } catch {
    return [];
  }
  const events: WelderEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as WelderEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

/**
 * Keep only the `keep` newest session logs (by mtime). Returns the count removed.
 * Missing directory is a no-op (returns 0).
 */
export async function pruneOldSessions(logDir: string, keep: number): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return 0;
  }
  const files = await Promise.all(
    entries
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (name) => {
        const stat = await fs.stat(path.join(logDir, name));
        return { name, mtime: stat.mtimeMs };
      }),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  const toRemove = files.slice(keep);
  await Promise.all(toRemove.map((f) => fs.unlink(path.join(logDir, f.name)).catch(() => {})));
  return toRemove.length;
}

/** Human-readable one-shot summary for the `/welder-stats` command. */
export function statsSummary(stats: Stats): string {
  const total = stats.totalToolCalls;
  const repaired = stats.repairedToolCalls;
  const totalRepairs = [...stats.repairsByAction.values()].reduce((a, b) => a + b, 0);

  const lines: string[] = ["📊 pi-welder — repair stats (this session)", ""];
  lines.push(`tool calls seen : ${total}`);
  lines.push(`calls repaired  : ${repaired}${total ? ` (${Math.round((repaired / total) * 100)}%)` : ""}`);
  lines.push(`repairs applied : ${totalRepairs}`);
  lines.push(`failed results : ${stats.failedToolResults}`);

  if (stats.repairsByAction.size > 0) {
    lines.push("", "by repair action:");
    const rows = [...stats.repairsByAction.entries()].sort((a, b) => b[1] - a[1]);
    const widest = Math.max(...rows.map((r) => r[0].length));
    for (const [action, count] of rows) {
      const pct = totalRepairs ? Math.round((count / totalRepairs) * 100) : 0;
      lines.push(`  ${action.padEnd(widest)}  ${String(count).padStart(4)}  ${pct}%`);
    }
  } else {
    lines.push("", "(no repairs needed yet — inputs have been clean)");
  }

  if (stats.failuresByTool.size > 0) {
    lines.push("", "by failed tool:");
    const rows = [...stats.failuresByTool.entries()].sort((a, b) => b[1] - a[1]);
    const widest = Math.max(...rows.map((r) => r[0].length));
    for (const [tool, count] of rows) {
      const pct = stats.failedToolResults ? Math.round((count / stats.failedToolResults) * 100) : 0;
      lines.push(`  ${tool.padEnd(widest)}  ${String(count).padStart(4)}  ${pct}%`);
    }
  }
  return lines.join("\n");
}

function classifyErrorKind(errorText: string): string {
  const first = errorText.split(/\s|:/)[0]?.trim();
  if (first && /^[A-Z][A-Z0-9_]+$/.test(first)) return first;
  const lower = errorText.toLowerCase();
  if (lower.includes("enoent") || lower.includes("no such file")) return "ENOENT";
  if (lower.includes("edit_mismatch") || lower.includes("oldtext")) return "EDIT_MISMATCH";
  if (lower.includes("schema") || lower.includes("invalid") || lower.includes("expected")) return "SCHEMA";
  return "TOOL_ERROR";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}
