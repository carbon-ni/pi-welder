import type { ContextEvent, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { repairArgs, type Repair, type RepairValidation } from "./repairs/index.ts";
import { repairToolResult as repairResult } from "./result-repairs/index.ts";
import type { DirectoryReadResult } from "./result-repairs/directory-read.ts";
import { preflightEditMismatch, recoverEditMismatch, type ModelRecoveryObservation, type ModelRecoveryPatch } from "./model-recovery/edit-mismatch.ts";
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
  buildModelRecoveryEvent,
  pruneOldSessions,
  recordRepairs,
  recordToolFailure,
  recordValidation,
} from "./recorder/index.ts";
import { logDir, modelMeta, sessionId } from "./pi-context.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";

export const DEFAULT_SESSION_RETENTION = 50;

interface ToolInputRepair {
  result: Record<string, unknown>;
  repairs: Repair[];
  validation?: RepairValidation;
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
    recordRepairWarnings(runtime.repairWarnings, repair.repairs, event.toolName);
    if (ctx.hasUI) ctx.ui.setStatus("welder", repairStatusText(event.toolName, repair.repairs));
  }

  await recordRepairEvent(ctx, event.toolName, repair);

  if (runtime.enabled && event.toolName === "edit") {
    const preflight = await preflightEditMismatch({
      toolInput: input as Record<string, unknown>,
      cwd: ctx.cwd,
      settings: runtime.modelRecovery,
      onObservation: (observation) => observeModelRecovery(runtime, event.toolName, observation, ctx),
    });
    if (preflight) {
      const repairs: Repair[] = Array.from({ length: preflight.repairedEdits }, (_, index) => ({ field: `edits[${index}].oldText`, action: "model-locate-old-text" }));
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
  const repair = repairArgs(input, { toolName });

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
): Promise<DirectoryReadResult | ModelRecoveryPatch | undefined> {
  const deterministicRepair = runtime.enabled ? await repairResult(event, ctx.cwd) : undefined;
  if (deterministicRepair) {
    recordRepairs(runtime.stats, deterministicRepair.repairs);
    await recordResultRepairEvent(ctx, event.toolName, event.input ?? {}, deterministicRepair.repairs);
    recordToolResult(runtime.recovery, { ...event, ...deterministicRepair.patch });
    return deterministicRepair.patch;
  }

  const modelRepair = runtime.enabled ? await recoverEditMismatch({
    event,
    cwd: ctx.cwd,
    settings: runtime.modelRecovery,
    onObservation: (observation) => observeModelRecovery(runtime, event.toolName, observation, ctx),
  }) : undefined;
  if (modelRepair) {
    recordRepairs(runtime.stats, modelRepair.repairs);
    await recordResultRepairEvent(ctx, event.toolName, event.input ?? {}, modelRepair.repairs);
    recordToolResult(runtime.recovery, { ...event, ...modelRepair.patch });
    return modelRepair.patch;
  }

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

async function observeModelRecovery(runtime: WelderRuntime, toolName: string, observation: ModelRecoveryObservation, ctx: ExtensionContext): Promise<void> {
  if (ctx.hasUI) ctx.ui.setStatus("welder", modelRecoveryStatus(observation.stage, observation.outcome, observation.reason));
  await appendEvent(logDir(ctx), sessionId(ctx), buildModelRecoveryEvent({
    toolName, provider: "openrouter", model: runtime.modelRecovery.model, ...observation,
  })).catch(() => {});
}

export function modelRecoveryStatus(stage: string, outcome: string, reason?: string): string {
  if (stage === "detected" && outcome === "attempting") return "🔧 edit: analyzing mismatch…";
  if (stage === "requested") return "🔧 edit: reasoning…";
  if ((stage === "decided" && outcome === "repair") || (stage === "validated" && outcome === "accepted")) return "🔧 edit: validating…";
  if (outcome === "success") return "🔧 edit: recovered";
  if (outcome === "abstained") return "🔧 edit: model abstained";
  if (outcome === "failed") return "🔧 edit: recovery unavailable";
  if (outcome === "rejected" || outcome === "skipped") return `🔧 edit: recovery ${outcome}${reason ? ` — ${reason}` : ""}`;
  return "🔧 edit: recovery detected";
}

async function recordResultRepairEvent(
  ctx: ExtensionContext,
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
