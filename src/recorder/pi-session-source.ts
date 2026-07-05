/**
 * Pi session source — reads Pi's native session JSONL logs and extracts tool
 * failures into the `FailureEvent` shape the aggregator consumes.
 *
 * Pi stores sessions under `~/.pi/agent/sessions/<workspace-slug>/*.jsonl`.
 * Each line is a record with a `type` field. Messages with role `toolResult`
 * carry `isError`; joining on `toolCallId` recovers the matching toolCall's
 * input keys from the preceding assistant message.
 *
 * No Pi APIs, no welder runtime. Pure parsing + filesystem.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyErrorKind } from "./events.ts";
import type { FailureEvent } from "./aggregate.ts";

interface PiRecord {
  type?: string;
  message?: PiMessage;
}

interface PiMessage {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
  timestamp?: number;
}

interface ToolCallBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

/**
 * Pure extraction: given parsed Pi session records, return one FailureEvent
 * per errored toolResult, joined to its toolCall for input keys.
 */
export function extractPiFailures(records: readonly PiRecord[]): FailureEvent[] {
  const callsById = new Map<string, ToolCallBlock>();
  for (const rec of records) {
    const msg = rec?.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as ToolCallBlock).type === "toolCall") {
        const c = block as ToolCallBlock;
        if (c.id) callsById.set(c.id, c);
      }
    }
  }

  const failures: FailureEvent[] = [];
  for (const rec of records) {
    const msg = rec?.message;
    if (!msg || msg.role !== "toolResult" || !msg.isError) continue;

    const call = msg.toolCallId ? callsById.get(msg.toolCallId) : undefined;
    const toolName = msg.toolName ?? call?.name ?? "unknown";
    const inputKeys = call?.arguments && typeof call.arguments === "object"
      ? Object.keys(call.arguments)
      : [];
    const errorText = extractContentText(msg.content);
    const ts = typeof msg.timestamp === "number"
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString();

    failures.push({
      toolName,
      wasError: true,
      errorKind: classifyErrorKind(errorText),
      errorText,
      inputKeys,
      ts,
    });
  }
  return failures;
}

/** Parse a single Pi session JSONL file into failures. Tolerates bad lines. */
export async function readPiSessionFile(file: string): Promise<FailureEvent[]> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const records: PiRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as PiRecord);
    } catch {
      /* skip malformed line */
    }
  }
  return extractPiFailures(records);
}

/** Read every `.jsonl` under all workspace subdirs of `sessionsDir`. */
export async function loadPiSessionEvents(sessionsDir: string): Promise<FailureEvent[]> {
  let workspaces: string[];
  try {
    workspaces = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const ws of workspaces) {
    const wsPath = path.join(sessionsDir, ws);
    let stat;
    try {
      stat = await fs.stat(wsPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(wsPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(path.join(wsPath, entry));
    }
  }

  const batches = await Promise.all(files.map((f) => readPiSessionFile(f)));
  return batches.flat();
}
