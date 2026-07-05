import * as path from "node:path";
import type { ContextEvent, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { repairArgs } from "./repairs.ts";
import {
  consumeRecoveryGuidance,
  extractToolErrorText,
  recordToolResult,
} from "./recovery.ts";
import {
  appendEvent,
  buildEvent,
  buildToolResultEvent,
  pruneOldSessions,
  recordRepairs,
  recordToolFailure,
} from "./recorder.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";

export const DEFAULT_SESSION_RETENTION = 50;

export const logDir = (ctx: ExtensionContext) => path.join(ctx.cwd ?? process.cwd(), ".pi", "welder-log");
export const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "unknown";
export const modelMeta = (ctx: ExtensionContext) => ({
  provider: ctx.model?.provider ?? "unknown",
  model: ctx.model?.id ?? "unknown",
});

export async function handleSessionStart(
  runtime: WelderRuntime,
  ctx: ExtensionContext,
  retention = DEFAULT_SESSION_RETENTION,
): Promise<void> {
  resetSessionState(runtime);
  runtime.stats.sessionId = sessionId(ctx);
  runtime.enabled = true;
  await pruneOldSessions(logDir(ctx), retention).catch(() => {});
  if (ctx.hasUI) ctx.ui.setStatus("welder", "🔧 welder: on");
}

export async function handleSessionShutdown(ctx: ExtensionContext): Promise<void> {
  if (ctx.hasUI) ctx.ui.setStatus("welder", undefined);
}

export async function handleToolCall(
  runtime: WelderRuntime,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<undefined> {
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
}

export async function handleToolResult(
  runtime: WelderRuntime,
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<undefined> {
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
}

export async function handleContext(runtime: WelderRuntime, event: ContextEvent): Promise<{ messages: unknown[] } | undefined> {
  const messages = consumeRecoveryGuidance(runtime.recovery);
  if (messages.length === 0) return undefined;
  return { messages: [...event.messages, ...messages] };
}
