import type { ContextEvent, ToolCallEvent, ToolResultEvent, WelderContext } from "./infra/pi/contracts.ts";
import { repairArgs, type Repair, type RepairValidation } from "./repairs/index.ts";
import { repairToolResult as repairResult, resultRepairRules, type ResultRepairPatch } from "./result-repairs/index.ts";
import { preflightEditMismatch } from "./model-recovery/edit-mismatch.ts";
import {
  consumeRecoveryGuidance,
  extractToolErrorText,
  recordToolResult,
} from "./recovery.ts";
import {
  consumeRepairWarnings,
  recordRepairWarnings,
} from "./repair-warnings.ts";
import {
  appendEvent,
  buildEvent,
  buildToolResultEvent,
  pruneOldSessions,
  recordRepairs,
  recordToolFailure,
  recordValidation,
} from "./recorder/index.ts";
import { logDir, modelMeta, sessionId } from "./infra/pi/context.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";

export const DEFAULT_SESSION_RETENTION = 50;

interface ToolInputRepair {
  result: Record<string, unknown>;
  repairs: Repair[];
  validation?: RepairValidation;
}

export function welderStatusText(runtime: WelderRuntime): string {
  return runtime.enabled ? "🔧 welder: on" : "🔧 welder: on (repairs off)";
}

export async function handleSessionStart(
  runtime: WelderRuntime,
  ctx: WelderContext,
  retention = DEFAULT_SESSION_RETENTION,
): Promise<void> {
  resetSessionState(runtime);
  runtime.stats.sessionId = sessionId(ctx);
  await pruneOldSessions(logDir(ctx), retention).catch(() => {});
  if (ctx.hasUI) ctx.ui.setStatus("welder", welderStatusText(runtime));
}

export async function handleSessionShutdown(ctx: WelderContext): Promise<void> {
  if (ctx.hasUI) ctx.ui.setStatus("welder", undefined);
}

export async function handleToolCall(
  runtime: WelderRuntime,
  event: ToolCallEvent,
  ctx: WelderContext,
): Promise<undefined> {
  const input = event.input;
  if (!input || typeof input !== "object") return undefined;

  const repair = repairToolInput(runtime, event.toolName, input as Record<string, unknown>);
  if (runtime.enabled && repair.repairs.length > 0) {
    applyRepairedInput(input as Record<string, unknown>, repair.result);
    recordRepairWarnings(runtime.repairWarnings, repair.repairs, event.toolName);
    if (ctx.hasUI) ctx.ui.setStatus("welder", repairStatusText(event.toolName, repair.repairs));
  }

  await recordRepairEvent(ctx, event.toolName, repair);

  if (runtime.enabled && event.toolName === "edit" && !runtime.disabledRepairs.has("resolve-ambiguous-edit")) {
    const preflight = await preflightEditMismatch({
      toolInput: input as Record<string, unknown>,
      cwd: ctx.cwd,
    });
    if (preflight) {
      const repairs: Repair[] = Array.from({ length: preflight.repairedEdits }, (_, index) => ({ field: `edits[${index}].oldText`, action: "resolve-ambiguous-edit" }));
      recordRepairs(runtime.stats, repairs);
      recordRepairWarnings(runtime.repairWarnings, repairs, event.toolName);
      await recordResultRepairEvent(ctx, event.toolName, input as Record<string, unknown>, repairs);
    }
  }
  return undefined;
}

export function repairToolInput(
  runtime: WelderRuntime,
  toolName: string,
  input: Record<string, unknown>,
): ToolInputRepair {
  runtime.stats.totalToolCalls++;
  const repair = repairArgs(input, { toolName, disabledActions: runtime.disabledRepairs });

  // In-memory stats always track the signal, even when repairs are off.
  recordValidation(runtime.stats, repair.validation);
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
  ctx: WelderContext,
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
  ctx: WelderContext,
): Promise<ResultRepairPatch | undefined> {
  const deterministicRepair = runtime.enabled
    ? await repairResult(event, ctx.cwd, resultRepairRules.filter((rule) => !runtime.disabledRepairs.has(rule.name)))
    : undefined;
  if (deterministicRepair) {
    recordRepairs(runtime.stats, deterministicRepair.repairs);
    await recordResultRepairEvent(ctx, event.toolName, event.input ?? {}, deterministicRepair.repairs);
    const repairedEvent = { ...event, ...deterministicRepair.patch };
    recordToolResult(runtime.recovery, repairedEvent);
    const errorText = extractToolErrorText(repairedEvent);
    if (errorText) await recordFailedToolResult(runtime, event, errorText, ctx);
    return deterministicRepair.patch;
  }

  recordToolResult(runtime.recovery, event);
  const errorText = extractToolErrorText(event);
  if (errorText) await recordFailedToolResult(runtime, event, errorText, ctx);
  return undefined;
}

async function recordFailedToolResult(
  runtime: WelderRuntime,
  event: ToolResultEvent,
  errorText: string,
  ctx: WelderContext,
): Promise<void> {
  recordToolFailure(runtime.stats, event.toolName);
  await appendEvent(logDir(ctx), sessionId(ctx), buildToolResultEvent({
    toolName: event.toolName,
    ...modelMeta(ctx),
    inputKeys: Object.keys(event.input ?? {}),
    errorText,
  })).catch(() => { /* logging never breaks recovery */ });
}

async function recordResultRepairEvent(
  ctx: WelderContext,
  toolName: string,
  input: Record<string, unknown>,
  repairs: Repair[],
): Promise<void> {
  await appendEvent(logDir(ctx), sessionId(ctx), buildEvent({
    eventType: "tool_result",
    toolName,
    ...modelMeta(ctx),
    repairs,
    inputKeys: Object.keys(input),
  })).catch(() => { /* logging never breaks result repair */ });
}

export async function handleContext(runtime: WelderRuntime, event: ContextEvent): Promise<{ messages: unknown[] } | undefined> {
  const recoveryMessages = consumeRecoveryGuidance(runtime.recovery);
  const warningMessages = consumeRepairWarnings(runtime.repairWarnings);
  const all = [...recoveryMessages, ...warningMessages];
  if (all.length === 0) return undefined;
  return { messages: [...event.messages, ...all] };
}
