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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SESSION_RETENTION,
  handleContext,
  handleSessionShutdown,
  handleSessionStart,
  handleToolCall,
  handleToolResult,
  logDir,
  sessionId,
} from "./handlers.ts";
import {
  clearRecovery,
  buildRecoveryGuidance,
  recoveryFailuresSummary,
  setRecoveryLimit,
} from "./recovery.ts";
import {
  statsSummary,
  sessionLogPath,
} from "./recorder.ts";
import { createRuntime, resetSessionState, type WelderRuntime } from "./runtime.ts";

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

  pi.on("session_start", async (_event, ctx) => handleSessionStart(runtime, ctx, DEFAULT_SESSION_RETENTION));

  pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));

  pi.on("tool_call", async (event, ctx) => handleToolCall(runtime, event, ctx));

  pi.on("tool_result", async (event, ctx) => handleToolResult(runtime, event, ctx));

  pi.on("context", async (event) => handleContext(runtime, event));

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
