import type { ContextEvent, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { repairArgs, type Repair } from "./repairs.ts";
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
import { logDir, modelMeta, sessionId } from "./pi-context.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";

export const DEFAULT_SESSION_RETENTION = 50;

interface ToolInputRepair {
  result: Record<string, unknown>;
  repairs: Repair[];
}

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

  const repair = repairToolInput(runtime, event.toolName, input as Record<string, unknown>);
  if (runtime.enabled && repair.repairs.length > 0) {
    applyRepairedInput(input as Record<string, unknown>, repair.result);
    if (ctx.hasUI) ctx.ui.setStatus("welder", repairStatusText(event.toolName, repair.repairs));
  }

  await recordRepairEvent(ctx, event.toolName, repair);
  return undefined;
}

export function repairToolInput(
  runtime: WelderRuntime,
  toolName: string,
  input: Record<string, unknown>,
): ToolInputRepair {
  runtime.stats.totalToolCalls++;
  const repair = repairArgs(input, { toolName });

  // In-memory stats always track the signal, even when repairs are off.
  if (repair.repairs.length > 0) recordRepairs(runtime.stats, repair.repairs);
  return repair;
}

export function applyRepairedInput(input: Record<string, unknown>, result: Record<string, unknown>): void {
  // Mutate in place — this is what the tool receives.
  for (const key of Object.keys(input)) delete input[key];
  Object.assign(input, result);
}

export function repairStatusText(toolName: string, repairs: Repair[]): string {
  const preview = repairs.slice(0, 2).map((r) => r.action).join(", ");
  const more = repairs.length > 2 ? ` (+${repairs.length - 2})` : "";
  return `🔧 ${toolName}: ${preview}${more}`;
}

async function recordRepairEvent(
  ctx: ExtensionContext,
  toolName: string,
  repair: ToolInputRepair,
): Promise<void> {
  // Log only the signal (repaired calls). Clean calls are counted in-memory only,
  // keeping the JSONL focused on what actually went wrong.
  if (repair.repairs.length === 0) return;

  await appendEvent(logDir(ctx), sessionId(ctx), buildEvent({
    eventType: "tool_call",
    toolName,
    ...modelMeta(ctx),
    repairs: repair.repairs,
    inputKeys: Object.keys(repair.result),
  })).catch(() => { /* logging never breaks the tool call */ });
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
