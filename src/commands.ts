import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logDir, sessionId } from "./pi-context.ts";
import {
  buildRecoveryGuidance,
  clearRecovery,
  recoveryFailuresSummary,
  setRecoveryLimit,
} from "./recovery.ts";
import { sessionLogPath, statsSummary } from "./recorder.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";

export interface WelderCommandSpec {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

export function parseLimitArg(args: string): number | null {
  const raw = args.trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function statusSummary(ctx: ExtensionContext, runtime: WelderRuntime): string {
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

export function welderCommandSpecs(runtime: WelderRuntime): WelderCommandSpec[] {
  return [
    {
      name: "welder-stats",
      description: "Show pi-welder repair stats for this session",
      handler: async (_args, ctx) => { ctx.ui.notify(statsSummary(runtime.stats), "info"); },
    },
    {
      name: "welder-status",
      description: "Show pi-welder runtime status",
      handler: async (_args, ctx) => { ctx.ui.notify(statusSummary(ctx, runtime), "info"); },
    },
    {
      name: "welder-reset",
      description: "Reset pi-welder session stats and pending recovery guidance",
      handler: async (_args, ctx) => {
        resetSessionState(runtime);
        runtime.stats.sessionId = sessionId(ctx);
        ctx.ui.notify("pi-welder: reset session stats and recovery state", "info");
      },
    },
    {
      name: "welder-on",
      description: "Enable pi-welder repairs",
      handler: async (_args, ctx) => {
        runtime.enabled = true;
        if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
        ctx.ui.notify("pi-welder: repairs enabled", "info");
      },
    },
    {
      name: "welder-off",
      description: "Disable pi-welder repairs (analytics still tracked in-memory)",
      handler: async (_args, ctx) => {
        runtime.enabled = false;
        if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: off");
        ctx.ui.notify("pi-welder: repairs disabled", "info");
      },
    },
    {
      name: "welder-toggle",
      description: "Toggle pi-welder repairs on/off",
      handler: async (_args, ctx) => {
        runtime.enabled = !runtime.enabled;
        if (ctx.hasUI) ctx.ui.setStatus("welder", `🔧 welder: ${runtime.enabled ? "on" : "off"}`);
        ctx.ui.notify(`pi-welder: ${runtime.enabled ? "enabled" : "disabled"}`, "info");
      },
    },
    {
      name: "welder-log",
      description: "Show the path to this session's welder repair log",
      handler: async (_args, ctx) => {
        ctx.ui.notify(sessionLogPath(logDir(ctx), sessionId(ctx)), "info");
      },
    },
    {
      name: "welder-guidance",
      description: "Show current pi-welder recovery guidance from recent tool failures",
      handler: async (_args, ctx) => {
        const messages = buildRecoveryGuidance(runtime.recovery);
        ctx.ui.notify(messages[0]?.content ?? "pi-welder: no recent tool failures", "info");
      },
    },
    {
      name: "welder-failures",
      description: "Show pending pi-welder tool failures without recovery hints",
      handler: async (_args, ctx) => {
        ctx.ui.notify(recoveryFailuresSummary(runtime.recovery), "info");
      },
    },
    {
      name: "welder-guidance-limit",
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
    },
    {
      name: "welder-clear",
      description: "Clear pending pi-welder recovery guidance",
      handler: async (_args, ctx) => {
        clearRecovery(runtime.recovery);
        ctx.ui.notify("pi-welder: cleared pending recovery guidance", "info");
      },
    },
  ];
}

export function registerWelderCommands(pi: ExtensionAPI, runtime: WelderRuntime): void {
  for (const spec of welderCommandSpecs(runtime)) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: spec.handler,
    });
  }
}
