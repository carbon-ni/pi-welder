/**
 * pi-welder — harness-level repair layer for LLM tool calls.
 *
 * One `tool_call` handler applies a finite set of structural repairs
 * (null-strip, JSON parse, array wrap, type coercion, …) before the tool
 * runs. Repairs are transparent and content fields are never touched.
 * Every repair is logged to `.pi/welder-log/<sessionId>.jsonl`.
 *
 * Commands: /welder-stats · /welder-on · /welder-off · /welder-toggle · /welder-log
 */

import * as path from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repairArgs } from "./repairs.ts";
import {
  createRecoveryState,
  clearRecovery,
  recordToolResult,
  buildRecoveryGuidance,
  consumeRecoveryGuidance,
  extractToolErrorText,
  type RecoveryState,
} from "./recovery.ts";
import {
  createStats,
  recordRepairs,
  recordToolFailure,
  buildEvent,
  buildToolResultEvent,
  appendEvent,
  pruneOldSessions,
  statsSummary,
  sessionLogPath,
  type Stats,
} from "./recorder.ts";

const SESSION_RETENTION = 50;

const logDir = (ctx: ExtensionContext) => path.join(ctx.cwd ?? process.cwd(), ".pi", "welder-log");
const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "unknown";
const modelMeta = (ctx: ExtensionContext) => ({
  provider: ctx.model?.provider ?? "unknown",
  model: ctx.model?.id ?? "unknown",
});

// Session-scoped state. Reset on every session_start.
let stats: Stats = createStats();
let recovery: RecoveryState = createRecoveryState();
let enabled = true;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    stats = createStats();
    recovery = createRecoveryState();
    stats.sessionId = sessionId(ctx);
    enabled = true;
    await pruneOldSessions(logDir(ctx), SESSION_RETENTION).catch(() => {});
    if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("welder", undefined);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const input = event.input;
    if (!input || typeof input !== "object") return undefined;
    stats.totalToolCalls++;

    const { result, repairs } = repairArgs(input);

    // In-memory stats always track the signal, even when repairs are off.
    if (repairs.length > 0) recordRepairs(stats, repairs);

    if (enabled && repairs.length > 0) {
      // Apply repairs by mutating event.input in place — this is what the tool receives.
      for (const key of Object.keys(input)) delete input[key];
      Object.assign(input, result);

      if (ctx.hasUI) {
        const preview = repairs.slice(0, 2).map((r) => r.action).join(", ");
        const more = repairs.length > 2 ? ` (+${repairs.length - 2})` : "";
        ctx.ui.setStatus("welder", `🔧 ${event.toolName}: ${preview}${more}`);
      }
    }

    // Log only the signal (repaired calls). Clean calls are counted in-memory only,
    // keeping the JSONL focused on what actually went wrong.
    if (repairs.length > 0) {
      await appendEvent(logDir(ctx), sessionId(ctx), buildEvent({
        eventType: "tool_call",
        toolName: event.toolName,
        ...modelMeta(ctx),
        repairs,
        inputKeys: Object.keys(result),
      })).catch(() => { /* logging never breaks the tool call */ });
    }

    return undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    recordToolResult(recovery, event);
    const errorText = extractToolErrorText(event);
    if (!errorText) return undefined;

    recordToolFailure(stats, event.toolName);
    await appendEvent(logDir(ctx), sessionId(ctx), buildToolResultEvent({
      toolName: event.toolName,
      ...modelMeta(ctx),
      inputKeys: Object.keys(event.input ?? {}),
      errorText,
    })).catch(() => { /* logging never breaks recovery */ });
    return undefined;
  });

  pi.on("context", async (event: ContextEvent) => {
    const messages = consumeRecoveryGuidance(recovery);
    if (messages.length === 0) return undefined;
    return { messages: [...event.messages, ...messages] };
  });

  // ─── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("welder-stats", {
    description: "Show pi-welder repair stats for this session",
    handler: async (_args, ctx) => { ctx.ui.notify(statsSummary(stats), "info"); },
  });

  pi.registerCommand("welder-on", {
    description: "Enable pi-welder repairs",
    handler: async (_args, ctx) => {
      enabled = true;
      if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
      ctx.ui.notify("pi-welder: repairs enabled", "info");
    },
  });

  pi.registerCommand("welder-off", {
    description: "Disable pi-welder repairs (analytics still tracked in-memory)",
    handler: async (_args, ctx) => {
      enabled = false;
      if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: off");
      ctx.ui.notify("pi-welder: repairs disabled", "info");
    },
  });

  pi.registerCommand("welder-toggle", {
    description: "Toggle pi-welder repairs on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (ctx.hasUI) ctx.ui.setStatus("welder", `🔧 welder: ${enabled ? "on" : "off"}`);
      ctx.ui.notify(`pi-welder: ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("welder-log", {
    description: "Show the path to this session's welder repair log",
    handler: async (_args, ctx) => {
      ctx.ui.notify(sessionLogPath(logDir(ctx), sessionId(ctx)), "info");
    },
  });

  pi.registerCommand("welder-guidance", {
    description: "Show current pi-welder recovery guidance from recent tool failures",
    handler: async (_args, ctx) => {
      const messages = buildRecoveryGuidance(recovery);
      ctx.ui.notify(messages[0]?.content ?? "pi-welder: no recent tool failures", "info");
    },
  });

  pi.registerCommand("welder-clear", {
    description: "Clear pending pi-welder recovery guidance",
    handler: async (_args, ctx) => {
      clearRecovery(recovery);
      ctx.ui.notify("pi-welder: cleared pending recovery guidance", "info");
    },
  });
}
