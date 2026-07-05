/**
 * pi-welder — harness-level repair layer for LLM tool calls.
 *
 * One `tool_call` handler applies a finite set of structural repairs
 * (null-strip, JSON parse, array wrap, type coercion, …) before the tool
 * runs. Repairs are transparent and content fields are never touched.
 * Every repair is logged to `.pi/welder-log/<sessionId>.jsonl`.
 *
 * Commands: /welder-stats · /welder-status · /welder-reset · /welder-on · /welder-off · /welder-toggle · /welder-log
 */

import * as path from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repairArgs } from "./repairs.ts";
import {
  clearRecovery,
  recordToolResult,
  buildRecoveryGuidance,
  consumeRecoveryGuidance,
  extractToolErrorText,
  recoveryFailuresSummary,
  setRecoveryLimit,
} from "./recovery.ts";
import {
  recordRepairs,
  recordToolFailure,
  buildEvent,
  buildToolResultEvent,
  appendEvent,
  pruneOldSessions,
  statsSummary,
  sessionLogPath,
} from "./recorder.ts";
import { createRuntime, resetSessionState, type WelderRuntime } from "./runtime.ts";

const SESSION_RETENTION = 50;

const logDir = (ctx: ExtensionContext) => path.join(ctx.cwd ?? process.cwd(), ".pi", "welder-log");
const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "unknown";
const modelMeta = (ctx: ExtensionContext) => ({
  provider: ctx.model?.provider ?? "unknown",
  model: ctx.model?.id ?? "unknown",
});

function parseLimitArg(args: string): number | null {
  const raw = args.trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function statusSummary(ctx: ExtensionContext, runtime: WelderRuntime): string {
  return [
    "pi-welder status",
    `enabled          : ${runtime.enabled}`,
    `guidance limit   : ${runtime.recovery.maxFailures}`,
    `pending failures : ${runtime.recovery.failures.length}`,
    `tool calls seen  : ${runtime.stats.totalToolCalls}`,
    `failed results   : ${runtime.stats.failedToolResults}`,
    `log file         : ${sessionLogPath(logDir(ctx), sessionId(ctx))}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const runtime = createRuntime();

  pi.on("session_start", async (_event, ctx) => {
    resetSessionState(runtime);
    runtime.stats.sessionId = sessionId(ctx);
    runtime.enabled = true;
    await pruneOldSessions(logDir(ctx), SESSION_RETENTION).catch(() => {});
    if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("welder", undefined);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const input = event.input;
    if (!input || typeof input !== "object") return undefined;
    runtime.stats.totalToolCalls++;

    const { result, repairs } = repairArgs(input, { toolName: event.toolName });

    // In-memory stats always track the signal, even when repairs are off.
    if (repairs.length > 0) recordRepairs(runtime.stats, repairs);

    if (runtime.enabled && repairs.length > 0) {
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
    recordToolResult(runtime.recovery, event);
    const errorText = extractToolErrorText(event);
    if (!errorText) return undefined;

    recordToolFailure(runtime.stats, event.toolName);
    await appendEvent(logDir(ctx), sessionId(ctx), buildToolResultEvent({
      toolName: event.toolName,
      ...modelMeta(ctx),
      inputKeys: Object.keys(event.input ?? {}),
      errorText,
    })).catch(() => { /* logging never breaks recovery */ });
    return undefined;
  });

  pi.on("context", async (event: ContextEvent) => {
    const messages = consumeRecoveryGuidance(runtime.recovery);
    if (messages.length === 0) return undefined;
    return { messages: [...event.messages, ...messages] };
  });

  // ─── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("welder-stats", {
    description: "Show pi-welder repair stats for this session",
    handler: async (_args, ctx) => { ctx.ui.notify(statsSummary(runtime.stats), "info"); },
  });

  pi.registerCommand("welder-status", {
    description: "Show pi-welder runtime status",
    handler: async (_args, ctx) => { ctx.ui.notify(statusSummary(ctx, runtime), "info"); },
  });

  pi.registerCommand("welder-reset", {
    description: "Reset pi-welder session stats and pending recovery guidance",
    handler: async (_args, ctx) => {
      resetSessionState(runtime);
      runtime.stats.sessionId = sessionId(ctx);
      ctx.ui.notify("pi-welder: reset session stats and recovery state", "info");
    },
  });

  pi.registerCommand("welder-on", {
    description: "Enable pi-welder repairs",
    handler: async (_args, ctx) => {
      runtime.enabled = true;
      if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
      ctx.ui.notify("pi-welder: repairs enabled", "info");
    },
  });

  pi.registerCommand("welder-off", {
    description: "Disable pi-welder repairs (analytics still tracked in-memory)",
    handler: async (_args, ctx) => {
      runtime.enabled = false;
      if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: off");
      ctx.ui.notify("pi-welder: repairs disabled", "info");
    },
  });

  pi.registerCommand("welder-toggle", {
    description: "Toggle pi-welder repairs on/off",
    handler: async (_args, ctx) => {
      runtime.enabled = !runtime.enabled;
      if (ctx.hasUI) ctx.ui.setStatus("welder", `🔧 welder: ${runtime.enabled ? "on" : "off"}`);
      ctx.ui.notify(`pi-welder: ${runtime.enabled ? "enabled" : "disabled"}`, "info");
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
      const messages = buildRecoveryGuidance(runtime.recovery);
      ctx.ui.notify(messages[0]?.content ?? "pi-welder: no recent tool failures", "info");
    },
  });

  pi.registerCommand("welder-failures", {
    description: "Show pending pi-welder tool failures without recovery hints",
    handler: async (_args, ctx) => {
      ctx.ui.notify(recoveryFailuresSummary(runtime.recovery), "info");
    },
  });

  pi.registerCommand("welder-guidance-limit", {
    description: "Set max recent tool failures included in recovery guidance (1-10)",
    handler: async (args, ctx) => {
      const limit = parseLimitArg(args);
      if (limit === null) {
        ctx.ui.notify("pi-welder: expected integer between 1 and 10", "error");
        return;
      }

      try {
        setRecoveryLimit(runtime.recovery, limit);
        ctx.ui.notify(`pi-welder: guidance limit set to ${limit}`, "info");
      } catch {
        ctx.ui.notify("pi-welder: expected integer between 1 and 10", "error");
      }
    },
  });

  pi.registerCommand("welder-clear", {
    description: "Clear pending pi-welder recovery guidance",
    handler: async (_args, ctx) => {
      clearRecovery(runtime.recovery);
      ctx.ui.notify("pi-welder: cleared pending recovery guidance", "info");
    },
  });
}
