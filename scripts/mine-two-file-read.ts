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
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
  isMissingError,
  mineTwoFileSelections,
  summarizeTwoFileMining,
  type SessionInput,
  type SessionReadCall,
} from "../src/mining/two-file-read.ts";

interface PiRecord {
  type?: string;
  cwd?: string;
  message?: PiMessage;
}

interface PiMessage {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
  details?: { missingReadContext?: { truncated?: boolean } };
}

interface ToolCallBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Canonical, cwd-independent session identity: the session's own recorded id
 * when present, plus the resolved file path. The miner hashes it, so neither
 * value is persisted.
 */
export async function sessionIdentity(file: string, sessionId: string | undefined): Promise<string> {
  const canonical = await fs.realpath(file).catch(() => path.resolve(file));
  return `${sessionId ?? ""}\u0000${canonical}`;
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
export function readCallsFromSession(content: string): { cwd: string; sessionId: string | undefined; calls: SessionReadCall[] } {
  const records: PiRecord[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as PiRecord);
    } catch {
      /* tolerate partial writes */
    }
  }

  const sessionRecord = records.find((record) => record.type === "session");
  const recordedCwd = typeof sessionRecord?.cwd === "string" ? sessionRecord.cwd : process.cwd();
  const sessionId = typeof (sessionRecord as { id?: unknown } | undefined)?.id === "string" ? (sessionRecord as { id: string }).id : undefined;
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
      resultText: errorText,
      detailsTruncated: message.details?.missingReadContext?.truncated === true,
    });
  }
  return { cwd: recordedCwd, sessionId, calls };
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
  const outFile = process.argv[3] ?? path.join(process.cwd(), ".tmp", "two-file-read-evidence.json");

  // Every session JSONL counts, including empty ones with no read at all.
  const files = await listSessionFiles(sessionsDir);
  const sessions: SessionInput[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => "");
    const { cwd, sessionId, calls } = readCallsFromSession(content);
    sessions.push({ sessionKey: await sessionIdentity(file, sessionId), cwd, calls });
  }

  const mined = mineTwoFileSelections(sessions);
  const summary = summarizeTwoFileMining(mined);
  const evidence = {
    generatedFrom: "pi-welder session logs (missing-read snapshot only; no filesystem access)",
    sessionsScanned: files.length,
    summary,
    records: mined.records,
  };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ outFile, ...summary }, null, 2));
}
