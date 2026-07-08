import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { logDir, sessionId } from "./pi-context.ts";
import {
  buildRecoveryGuidance,
  clearRecovery,
  recoveryFailuresSummary,
  setRecoveryLimit,
} from "./recovery.ts";
import {
  aggregateFailures,
  formatFailureReport,
  loadAllEvents,
  loadPiSessionEvents,
  sessionLogPath,
  statsSummary,
  writeFailureReport,
  type FailureEvent,
} from "./recorder/index.ts";
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

export interface MineResult {
  reportPath: string;
  source: MineSource;
  clusters: number;
  totalFailures: number;
  topCluster: string | null;
}

export type MineSource = "welder" | "pi" | "all";

export const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

export function parseMineSource(args: string): MineSource {
  const raw = args.trim().toLowerCase();
  if (raw === "pi" || raw === "welder" || raw === "all") return raw;
  return "all";
}

/**
 * Failure analysis over already-loaded events: aggregate, format, write.
 * Source selection happens in the caller; this stays pure over events.
 */
export async function mineFailures(
  events: readonly FailureEvent[],
  reportDir: string,
  write: (dir: string, content: string) => Promise<string>,
  source: MineSource = "all",
): Promise<MineResult> {
  const clusters = aggregateFailures(events);
  const report = formatFailureReport(clusters);
  const reportPath = await write(reportDir, report);
  const totalFailures = clusters.reduce((sum, c) => sum + c.count, 0);
  const top = clusters[0];
  return {
    reportPath,
    source,
    clusters: clusters.length,
    totalFailures,
    topCluster: top ? `${top.toolName} / ${top.errorKind} (×${top.count})` : null,
  };
}

/** Load events from the chosen source(s). Pure over injected loaders. */
export async function loadMineEvents(
  source: MineSource,
  deps: {
    welderLogDir: string;
    piSessionsDir: string;
    loadWelder: (dir: string) => Promise<FailureEvent[]>;
    loadPi: (dir: string) => Promise<FailureEvent[]>;
  },
): Promise<FailureEvent[]> {
  if (source === "welder") return deps.loadWelder(deps.welderLogDir);
  if (source === "pi") return deps.loadPi(deps.piSessionsDir);
  const [welder, pi] = await Promise.all([
    deps.loadWelder(deps.welderLogDir).catch(() => []),
    deps.loadPi(deps.piSessionsDir).catch(() => []),
  ]);
  return [...welder, ...pi];
}

export function mineSummary(result: MineResult): string {
  if (result.clusters === 0) {
    return `pi-welder: no failures found (source: ${result.source}). Report at ${result.reportPath}`;
  }
  return [
    "pi-welder failure report",
    `source    : ${result.source}`,
    `report    : ${result.reportPath}`,
    `clusters  : ${result.clusters}`,
    `failures  : ${result.totalFailures}`,
    `top       : ${result.topCluster}`,
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
    {
      name: "welder-mine",
      description: "Aggregate tool failures across sessions. Args: pi | welder | all (default all)",
      handler: async (args, ctx) => {
        try {
          const source = parseMineSource(args);
          const events = await loadMineEvents(source, {
            welderLogDir: logDir(ctx),
            piSessionsDir: PI_SESSIONS_DIR,
            loadWelder: loadAllEvents,
            loadPi: loadPiSessionEvents,
          });
          const result = await mineFailures(events, logDir(ctx), writeFailureReport, source);
          ctx.ui.notify(mineSummary(result), "info");
        } catch (err) {
          ctx.ui.notify(`pi-welder: failed to mine failures: ${String(err)}`, "error");
        }
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
