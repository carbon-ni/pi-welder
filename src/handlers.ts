import type { ContextEvent, ToolCallEvent, ToolResultEvent, WelderContext } from "./infra/pi/contracts.ts";
import { repairArgs, type Repair, type RepairValidation } from "./repairs/index.ts";
import { repairToolResult as repairResult, resultRepairRules, type ResultRepairPatch } from "./result-repairs/index.ts";
import { preflightEditMismatch } from "./model-recovery/edit-mismatch.ts";
import { buildAmbiguousShadowRequest } from "./model-recovery/ambiguous-shadow.ts";
import {
  extractToolErrorText,
  recordToolResult,
} from "./recovery.ts";
import {
  consumeRepairWarnings,
  recordRepairWarnings,
} from "./repair-warnings.ts";
import {
  appendEvent,
  buildEpisodeEvent,
  buildEvent,
  buildShadowEvent,
  buildToolResultEvent,
  pruneOldSessions,
  recordRepairs,
  recordToolFailure,
  recordValidation,
} from "./recorder/index.ts";
import { logDir, modelMeta, sessionId } from "./infra/pi/context.ts";
import { resetSessionState, type WelderRuntime } from "./runtime.ts";
import type { EpisodeRecord } from "./episodes.ts";
import { buildRestoreReadReason, recognizeReadShapedEdit } from "./read-shape.ts";

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
  // Persist only safe shadow metadata (counts, ordinals, latency); payloads stay in memory.
  runtime.onShadowEvidence = (evidence) => {
    void appendEvent(logDir(ctx), sessionId(ctx), buildShadowEvent(evidence, modelMeta(ctx))).catch(() => { /* logging never breaks tool flow */ });
  };
  await pruneOldSessions(logDir(ctx), retention).catch(() => {});
  if (ctx.hasUI) ctx.ui.setStatus("welder", welderStatusText(runtime));
}

export async function handleSessionShutdown(runtime: WelderRuntime, ctx: WelderContext): Promise<void> {
  await runtime.jevShadow?.shutdown().catch(() => { /* never block shutdown */ });
  await appendEpisodeRecords(runtime.episodes.closeAll(), ctx).catch(() => { /* never block shutdown */ });
  if (ctx.hasUI) ctx.ui.setStatus("welder", undefined);
}

async function appendEpisodeRecords(records: readonly EpisodeRecord[], ctx?: WelderContext): Promise<void> {
  if (!ctx || records.length === 0) return;
  const now = Date.now();
  for (const record of records) {
    await appendEvent(logDir(ctx), sessionId(ctx), buildEpisodeEvent(record, now)).catch(() => { /* logging never breaks tool flow */ });
  }
}

/**
 * Tool-call outcome. Pi's `ToolCallEventResult` supports blocking only
 * (`{ block?: boolean; reason?: string }`); it cannot replace tool identity,
 * so a restored read call is delivered through the block reason.
 */
export type ToolCallOutcome = { block: true; reason: string } | undefined;

export async function handleToolCall(
  runtime: WelderRuntime,
  event: ToolCallEvent,
  ctx: WelderContext,
): Promise<ToolCallOutcome> {
  const input = event.input;
  if (!input || typeof input !== "object") return undefined;

  // Read-shaped edit: recognized on the ORIGINAL input (repairArgs could add
  // defaults), blocked before execution, and answered with the exact read call.
  if (runtime.enabled && event.toolName === "edit" && !runtime.disabledRepairs.has("restore-read-shape")) {
    const restoredRead = recognizeReadShapedEdit(input);
    if (restoredRead) {
      runtime.stats.totalToolCalls++;
      const repairs: Repair[] = [{ field: "input", action: "restore-read-shape" }];
      recordRepairs(runtime.stats, repairs);
      recordRepairWarnings(runtime.repairWarnings, repairs, event.toolName);
      if (ctx.hasUI) ctx.ui.setStatus("welder", repairStatusText(event.toolName, repairs));
      await recordRepairEvent(ctx, event.toolName, { result: input as Record<string, unknown>, repairs });
      runtime.episodes.observeCall({ toolName: event.toolName, actions: ["restore-read-shape"] });
      return { block: true, reason: buildRestoreReadReason(restoredRead) };
    }
  }

  const repair = repairToolInput(runtime, event.toolName, input as Record<string, unknown>);
  const callActions = repair.repairs.map((r) => r.action);
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
      callActions.push("resolve-ambiguous-edit");
      await recordResultRepairEvent(ctx, event.toolName, input as Record<string, unknown>, repairs);
    }
  }

  observeAndMaybeSubmitShadow(runtime, event, ctx, input as Record<string, unknown>);

  runtime.episodes.observeCall({ toolName: event.toolName, actions: callActions });
  return undefined;
}

/**
 * Shadow-only evidence collection. Eligibility is strictly 2–5 exact candidate
 * occurrences of a single edit; the original call proceeds unchanged and the
 * deferred Jev request can never mutate input, results, or files.
 */
function observeAndMaybeSubmitShadow(
  runtime: WelderRuntime,
  event: ToolCallEvent,
  ctx: WelderContext,
  input: Record<string, unknown>,
): void {
  const shadow = runtime.jevShadow;
  if (!shadow || event.toolName !== "edit" || typeof event.toolCallId !== "string") return;
  const path = typeof input.path === "string" ? input.path : undefined;
  const oldText = readSingleEditOldText(input);
  shadow.observeToolCall({ toolName: event.toolName, toolCallId: event.toolCallId, path, oldText });
  // Strict eligibility: deterministic preflight must have been attempted and
  // abstained. With the repair disabled there is no attempted preflight, so
  // no Jev request is submitted.
  if (runtime.disabledRepairs.has("resolve-ambiguous-edit")) return;
  if (!path || !oldText) return;
  void buildAmbiguousShadowRequest({ cwd: ctx.cwd, toolInput: input })
    .catch(() => undefined)
    .then((request) => {
      if (!request || runtime.jevShadow !== shadow) return;
      shadow.submit({ toolCallId: event.toolCallId!, path, candidates: request.candidates, requestedEditText: request.requestedEditText });
    });
}

function readSingleEditOldText(input: Record<string, unknown>): string | undefined {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length !== 1) return undefined;
  const oldText = (edits[0] as Record<string, unknown> | undefined)?.oldText;
  return typeof oldText === "string" ? oldText : undefined;
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
  // Correlate this result with episodes opened before the call was made.
  const closedRecords = runtime.episodes.observeResult({ toolName: event.toolName, isError: event.isError === true });
  runtime.jevShadow?.observeToolResult({ toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError === true });
  await appendEpisodeRecords(closedRecords, ctx).catch(() => { /* logging never breaks results */ });

  const deterministicRepair = runtime.enabled
    ? await repairResult(event, ctx.cwd, resultRepairRules.filter((rule) => !runtime.disabledRepairs.has(rule.name)))
    : undefined;
  if (deterministicRepair) {
    recordRepairs(runtime.stats, deterministicRepair.repairs);
    await recordResultRepairEvent(ctx, event.toolName, event.input ?? {}, deterministicRepair.repairs);
    const evicted = runtime.episodes.open({
      kind: "result-repair",
      toolName: event.toolName,
      repairs: deterministicRepair.repairs,
      ...modelMeta(ctx),
      inputKeys: Object.keys(event.input ?? {}),
    });
    await appendEpisodeRecords(evicted, ctx).catch(() => { /* logging never breaks result repair */ });
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

export async function handleContext(runtime: WelderRuntime, event: ContextEvent, ctx?: WelderContext): Promise<{ messages: unknown[] } | undefined> {
  const warningMessages = consumeRepairWarnings(runtime.repairWarnings);
  if (warningMessages.length === 0) return undefined;
  const evicted = runtime.episodes.openWarnings(runtime.repairWarnings.warnings);
  await appendEpisodeRecords(evicted, ctx).catch(() => { /* logging never breaks context */ });
  return { messages: [...event.messages, ...warningMessages] };
}
