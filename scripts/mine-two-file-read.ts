/**
 * TASK-0043 — offline two-file missing-read miner.
 *
 * Reads Pi's native session JSONL logs, replays every `read` call in order, and
 * mines the pure two-file heuristic. Nothing here touches welder's runtime, and
 * the evidence it writes is metadata only: counts, ratios, and reason names.
 * Session identifiers are hashed to a short digest so "session concentration"
 * stays measurable without recording where the work happened.
 *
 * Usage: node --experimental-strip-types scripts/mine-two-file-read.ts [sessionsDir] [outFile]
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
  isMissingError,
  mineTwoFileSelections,
  parentDirectoryOf,
  summarizeTwoFileMining,
  type SessionReadCall,
} from "../src/mining/two-file-read.ts";

interface PiRecord {
  message?: PiMessage;
}

interface PiMessage {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

interface ToolCallBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/** Short, non-reversible session digest: enough to count concentration. */
function sessionDigest(file: string): string {
  return createHash("sha256").update(path.basename(file)).digest("hex").slice(0, 12);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Replays one session file into the ordered `read` calls it contains. A read
 * call without a matching result is dropped: we only count observed outcomes.
 */
export function readCallsFromSession(content: string): SessionReadCall[] {
  const records: PiRecord[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as PiRecord);
    } catch {
      /* tolerate partial writes */
    }
  }

  const callById = new Map<string, { path: string }>();
  for (const record of records) {
    const message = record.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as ToolCallBlock;
      if (call?.type !== "toolCall" || call.name !== "read" || typeof call.id !== "string") continue;
      const requested = call.arguments?.path;
      if (typeof requested === "string") callById.set(call.id, { path: requested });
    }
  }

  const calls: SessionReadCall[] = [];
  for (const record of records) {
    const message = record.message;
    if (message?.role !== "toolResult" || message.toolName !== "read") continue;
    const request = message.toolCallId !== undefined ? callById.get(message.toolCallId) : undefined;
    if (!request) continue;
    const errorText = textOf(message.content);
    calls.push({
      identifier: message.toolCallId ?? `anonymous:${calls.length}`,
      path: request.path,
      isError: message.isError === true,
      missing: message.isError === true && isMissingError(errorText),
    });
  }
  return calls;
}

/** The current regular files of a directory, or undefined when unreadable. */
async function directoryListing(directory: string): Promise<readonly string[] | undefined> {
  const absolute = path.isAbsolute(directory) ? directory : path.resolve(process.cwd(), directory);
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return undefined;
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

/** Every session file under a Pi sessions directory. */
export async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  const workspaces = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const entries = await fs.readdir(path.join(sessionsDir, workspace.name), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(sessionsDir, workspace.name, entry.name));
    }
  }
  return files.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessionsDir = process.argv[2] ?? path.join(homedir(), ".pi", "agent", "sessions");
  const outFile = process.argv[3] ?? path.join(process.cwd(), ".tmp", "mine-two-file-read.ts");

  const files = await listSessionFiles(sessionsDir);
  const sessions: { sessionKey: string; calls: SessionReadCall[] }[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => "");
    const calls = readCallsFromSession(content);
    if (calls.length > 0) sessions.push({ sessionKey: sessionDigest(file), calls });
  }

  // The pure miner takes a synchronous view of the filesystem, so every
  // directory a missing read named is listed once, up front.
  const directories = new Set<string>();
  for (const session of sessions) {
    for (const call of session.calls) {
      if (call.isError && call.missing) directories.add(parentDirectoryOf(call.path));
    }
  }
  const listings = new Map<string, readonly string[] | undefined>();
  await Promise.all([...directories].map(async (directory) => {
    listings.set(directory, await directoryListing(directory));
  }));

  const mined = mineTwoFileSelections(sessions, (directory) => listings.get(directory));

  const summary = summarizeTwoFileMining(mined, sessions.length);
  const evidence = [
    "/** Generated by scripts/mine-two-file-read.ts (TASK-0043). Metadata only:",
    " * counts, ratios, and reason names. No paths, file names, session ids, or",
    " * contents. Do not commit. */",
    `export const EVIDENCE = ${JSON.stringify({ generatedFrom: "pi-welder session logs", ...summary }, null, 2)} as const;`,
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, evidence);
  console.log(JSON.stringify({ outFile, ...summary }, null, 2));
}
