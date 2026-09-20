/**
 * pi-welder — harness-level repair layer for LLM tool calls.
 *
 * One `tool_call` handler applies a finite set of structural repairs
 * (null-strip, JSON parse, array wrap, type coercion, …) before the tool
 * runs, and blocks read-shaped `edit` calls with the exact corrected `read`
 * call (TASK-0028). Repairs are transparent and content fields are never
 * touched. Every repair is logged to `.pi/welder-log/<sessionId>.jsonl`.
 *
 * Commands: /welder-stats · /welder-reset · /welder-log · /welder-failures · /welder-clear · /welder-settings
 */

import {
  createBashTool,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ExtensionHost, WelderContext } from "./infra/pi/contracts.ts";
import { wrapToolForBashRouting, type BashDelegate, type RouteToolName, type ToolLike } from "./command-routing/wrapper.ts";
import { createTypeSafeBashJudgeClient } from "./bash-judgment/client.ts";
import { appendEvent, buildEvent, recordRepairs } from "./recorder/index.ts";
import { logDir, modelMeta, sessionId } from "./infra/pi/context.ts";
import { recordRepairWarnings } from "./repair-warnings.ts";
import type { Repair } from "./repairs/index.ts";
import { registerWelderCommands } from "./commands.ts";
import { loadWelderConfig } from "./config.ts";
import {
  DEFAULT_SESSION_RETENTION,
  handleContext,
  handleSessionShutdown,
  handleSessionStart,
  handleToolCall,
  handleToolResult,
} from "./handlers.ts";
import { createRuntime, setBashRouteTrust } from "./runtime.ts";
import { createTypeSafeJevClient } from "./infra/typesafe.ts";
import { READ_PATH_PROMPT } from "./read-recovery/path-repair.ts";

/**
 * TASK-0034 composition-root delegate: Pi's built-in bash tool, never a direct
 * Node shell. The command, timeout, cwd, and abort signal pass through
 * unchanged. Pi's bash tool throws on non-zero exit, timeout, and abort, so the
 * wrapper converts a throw into an error result instead of claiming success.
 */
const piBashDelegate: BashDelegate = async ({ command, timeout, cwd, signal, toolCallId }) => {
  const tool = createBashTool(cwd);
  const result = await tool.execute(toolCallId, { command, ...(timeout === undefined ? {} : { timeout }) }, signal);
  return { content: result.content, details: result.details, isError: false };
};

/** Built-in definitions, resolved per call so each uses the session cwd. */
const resolveBuiltinFor = (toolName: RouteToolName) => (cwd: string): ToolLike => {
  if (toolName === "read") return createReadToolDefinition(cwd) as unknown as ToolLike;
  if (toolName === "write") return createWriteToolDefinition(cwd) as unknown as ToolLike;
  return createEditToolDefinition(cwd) as unknown as ToolLike;
};

export default function (pi: ExtensionHost) {
  const config = loadWelderConfig();
  // Whitespace-only or absent keys mean no client exists at all.
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || undefined;
  // Dedicated classifier capability; absent without a key, so it stays inert.
  const bashJudge = apiKey ? createTypeSafeBashJudgeClient({ apiKey }) : undefined;
  const runtime = createRuntime({
    ...config,
    // Client exists whenever an API key is present, so the setting can be
    // toggled on live; sourceShadowingEnabled alone controls actual use.
    jevClient: apiKey ? createTypeSafeJevClient({ apiKey }) : undefined,
    // Read-path repair uses its own question/instructions and is gated by the
    // readPathRepairEnabled setting plus the frozen evidence verdict.
    readPathClient: apiKey ? createTypeSafeJevClient({ apiKey, prompt: READ_PATH_PROMPT }) : undefined,
  });

  // TASK-0034: same-name wrappers keep the strict built-in schemas and route an
  // exact bash-shaped call to bash. Registered here, at the composition root.
  for (const toolName of ["read", "write", "edit"] as const) {
    pi.registerTool(wrapToolForBashRouting({
      builtin: resolveBuiltinFor(toolName)(process.cwd()),
      toolName,
      state: runtime.bashRouteState,
      delegate: piBashDelegate,
      resolveBuiltin: resolveBuiltinFor(toolName),
      // Dedicated classifier: a non-exact sentinel is only created when this
      // capability exists, so no key means the feature stays fully inert.
      ...(bashJudge === undefined ? {} : { judgeBash: bashJudge }),
      onRouted: (audit, ctx) => {
        // Audit carries the source and target tool names only: never the command.
        const context = ctx as WelderContext;
        const repairs: Repair[] = [{ field: "input", action: "route-to-bash" }];
        runtime.stats.totalToolCalls++;
        if (audit.classified === true) {
          repairs.push({ field: "input", action: "route-to-bash" });
          if (context.hasUI) context.ui.setStatus("welder", `🔧 ${audit.sourceTool}: route-to-bash (jev-classified)`);
        }
        recordRepairs(runtime.stats, repairs);
        recordRepairWarnings(runtime.repairWarnings, repairs, audit.sourceTool);
        void appendEvent(logDir(context), sessionId(context), buildEvent({
          eventType: "tool_call",
          toolName: audit.sourceTool,
          targetTool: audit.targetTool,
          ...modelMeta(context),
          repairs,
          inputKeys: [],
          ...(audit.classified === true ? { classified: true } : {}),
        })).catch(() => { /* logging never breaks tool flow */ });
      },
    }));
  }

  pi.on("session_start", async (_event, ctx) => {
    // Trust gates the pre-validation sentinel; execute re-checks ctx as well.
    setBashRouteTrust(runtime, ctx.isProjectTrusted?.() === true);
    await handleSessionStart(runtime, ctx, DEFAULT_SESSION_RETENTION);
  });

  pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(runtime, ctx));

  pi.on("tool_call", async (event, ctx) => handleToolCall(runtime, event, ctx));

  pi.on("tool_result", async (event, ctx) => handleToolResult(runtime, event, ctx));

  pi.on("context", async (event, ctx) => handleContext(runtime, event, ctx));

  registerWelderCommands(pi, runtime);
}
