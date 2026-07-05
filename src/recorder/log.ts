import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WelderEvent } from "./events.ts";

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

/** List `.jsonl` session log files in a directory (sorted by name). Missing dir → []. */
export async function listSessionLogs(logDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".jsonl")).sort();
}

/** Read every `.jsonl` session log in `logDir` and concatenate events. */
export async function loadAllEvents(logDir: string): Promise<WelderEvent[]> {
  const files = await listSessionLogs(logDir);
  const batches = await Promise.all(files.map((f) => readEvents(path.join(logDir, f))));
  return batches.flat();
}

export const FAILURE_REPORT_FILENAME = "failures-report.md";

/** Write a failure report markdown file into `logDir`. Returns its path. */
export async function writeFailureReport(logDir: string, content: string): Promise<string> {
  await fs.mkdir(logDir, { recursive: true });
  const reportPath = path.join(logDir, FAILURE_REPORT_FILENAME);
  await fs.writeFile(reportPath, content, "utf8");
  return reportPath;
}
