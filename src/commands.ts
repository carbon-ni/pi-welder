import type { CommandRegistrar, WelderContext } from "./infra/pi/contracts.ts";
import * as os from "node:os";
import * as path from "node:path";
import { logDir, sessionId } from "./infra/pi/context.ts";
import { loadWelderConfig, saveWelderConfig } from "./config.ts";
import { applyWelderSetting, welderSettingItems } from "./welder-settings.ts";
import { openWelderSettings } from "./infra/pi/settings-ui.ts";
import type { WelderConfig } from "./config.ts";
import { setCommandReroutingEnabled, setDisabledRepairs, setRepairsEnabled } from "./runtime.ts";
import {
  clearRecovery,
  recoveryFailuresSummary,
  setRecoveryLimit,
} from "./recovery.ts";
import {
  aggregateFailures,
  aggregateRepairs,
  formatFailureReport,
  loadAllEvents,
  loadPiSessionEvents,
  sessionLogPath,
  statsSummary,
  writeFailureReport,
  type FailureEvent,
} from "./recorder/index.ts";
import { resetSessionState, setSourceShadowingEnabled, type WelderRuntime } from "./runtime.ts";
import { welderStatusText } from "./handlers.ts";
import { aggregateShadowStats, fromShadowEvidence, renderShadowStats } from "./model-recovery/shadow-stats.ts";

export interface WelderCommandSpec {
  name: string;
  description: string;
  handler: (args: string, ctx: WelderContext) => Promise<void>;
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
  modelRepairReportingEnabled = false,
): Promise<MineResult> {
  const clusters = aggregateFailures(events);
  const repairs = modelRepairReportingEnabled ? aggregateRepairs(events) : [];
  const report = formatFailureReport(clusters, repairs);
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

/**
 * Applies a loaded config to the live runtime. Every toggle takes effect without
 * a restart, and the bash-routing gate reads these fields live.
 */
export function syncRuntimeConfig(runtime: WelderRuntime, current: WelderConfig): void {
  runtime.modelRepairReportingEnabled = current.modelRepairReportingEnabled;
  // TASK-0039: the read-path repair reads this field live on every tool call.
  runtime.readPathRepairEnabled = current.readPathRepairEnabled;
  setRepairsEnabled(runtime, current.repairsEnabled);
  setDisabledRepairs(runtime, current.disabledRepairs);
  setCommandReroutingEnabled(runtime, current.commandReroutingEnabled);
  setSourceShadowingEnabled(runtime, current.sourceShadowingEnabled);
  try {
    setRecoveryLimit(runtime.recovery, current.recoveryGuidanceLimit);
  } catch {
    /* config is parsed to a valid 1-10 integer */
  }
}

export function welderCommandSpecs(runtime: WelderRuntime): WelderCommandSpec[] {
  return [
    {
      name: "welder-stats",
      description: "Show pi-welder repair stats for this session",
      handler: async (_args, ctx) => { ctx.ui.notify(statsSummary(runtime.stats), "info"); },
    },
    {
      name: "welder-shadow-stats",
      description: "Show metadata-only Jev shadow activity and labels for this session",
      handler: async (_args, ctx) => {
        // Activity (submitted/completed/statuses/latency) stays separate from
        // label states; no precision claim is possible without reviewed labels.
        const stats = aggregateShadowStats(runtime.shadowEvidence.map(fromShadowEvidence), runtime.jevShadow?.submitted);
        ctx.ui.notify(renderShadowStats(stats), "info");
      },
    },
    {
      name: "welder-reset",
      description: "Reset pi-welder session stats and pending failures",
      handler: async (_args, ctx) => {
        resetSessionState(runtime);
        runtime.stats.sessionId = sessionId(ctx);
        ctx.ui.notify("pi-welder: reset session stats and failure state", "info");
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
      name: "welder-failures",
      description: "Show pending pi-welder tool failures and input keys",
      handler: async (_args, ctx) => {
        ctx.ui.notify(recoveryFailuresSummary(runtime.recovery), "info");
      },
    },
    {
      name: "welder-clear",
      description: "Clear pending pi-welder failures",
      handler: async (_args, ctx) => {
        clearRecovery(runtime.recovery);
        ctx.ui.notify("pi-welder: cleared pending failures", "info");
      },
    },
    {
      name: "welder-settings",
      description: "Toggle pi-welder config options (TUI)",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui" || !ctx.ui.custom) {
          ctx.ui.notify("pi-welder: /welder-settings requires interactive TUI mode", "error");
          return;
        }
        let current = loadWelderConfig();
        const items = welderSettingItems(current);
        await openWelderSettings(ctx, items, (id, value) => {
          current = applyWelderSetting(current, id, value);
          syncRuntimeConfig(runtime, current);
          ctx.ui.setStatus("welder", welderStatusText(runtime));
          try {
            saveWelderConfig(current);
          } catch {
            ctx.ui.notify("pi-welder: failed to persist settings", "error");
          }
        });
      },
    },
  ];
}

export function registerWelderCommands(pi: CommandRegistrar, runtime: WelderRuntime): void {
  for (const spec of welderCommandSpecs(runtime)) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: spec.handler,
    });
  }
}
