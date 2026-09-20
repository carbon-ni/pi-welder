/**
 * TASK-0031 — session JSONL → edit-focused events (shared by the evaluation
 * script and tests). Pure over the file text; raw values remain in memory only.
 */

import type { EditEvent } from "./episode.ts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

export interface ParsedSession {
  sessionId: string;
  events: EditEvent[];
}

/** Parses one transcript's text into ordered edit-focused events. */
export function parseSessionText(text: string): ParsedSession {
  let sessionId = "";
  const events: EditEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === "session" && typeof entry.id === "string") {
      sessionId = entry.id;
      continue;
    }
    const message = entry.message;
    if (!message || typeof entry.timestamp !== "string") continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const input = (block.arguments ?? {}) as Record<string, unknown>;
        const firstEdit = Array.isArray(input.edits) ? (input.edits[0] as Record<string, unknown> | undefined) : undefined;
        events.push({
          id: block.id,
          ts: entry.timestamp,
          kind: "toolCall",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolCallId: block.id,
          ...(typeof input.path === "string" ? { path: input.path } : {}),
          ...(typeof firstEdit?.oldText === "string" ? { oldText: firstEdit.oldText } : {}),
          ...(typeof firstEdit?.newText === "string" ? { newText: firstEdit.newText } : {}),
        });
      }
      continue;
    }
    if (message.role === "user") {
      const content = textOf(message.content);
      if (content) events.push({ id: `${entry.id ?? events.length}`, ts: entry.timestamp, kind: "user" });
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const content = textOf(message.content);
      events.push({
        id: message.toolCallId,
        ts: entry.timestamp,
        kind: "toolResult",
        toolCallId: message.toolCallId,
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        ...(content ? { errorText: content } : {}),
      });
    }
  }
  return { sessionId, events };
}
