import type { JevClient, JevClientError } from "../infra/typesafe.ts";

export const DEFAULT_SHADOW_CONFIDENCE = 0.99;
export const DEFAULT_SHADOW_TIMEOUT_MS = 2_000;
export const DEFAULT_SHADOW_SESSION_LIMIT = 10;
export const DEFAULT_SHADOW_LABEL_WINDOW = 3;

export interface ShadowRequest {
  toolCallId: string;
  path: string;
  candidates: readonly { ordinal: number; window: string }[];
  requestedEditText: string;
}

export type ShadowStatus = "selected" | "abstain" | "low-confidence" | "malformed" | "rate-limited" | "transport" | "timeout" | "cancelled";
export type ShadowLabelStatus = "pending" | "provisional-correct" | "provisional-incorrect";

export interface ShadowEvidence {
  toolCallId: string;
  candidateCount: number;
  selectedOrdinal?: number;
  confidence?: number;
  model?: string;
  latencyMs: number;
  status: ShadowStatus;
  labelStatus: ShadowLabelStatus;
}

export interface ShadowToolCallObservation {
  toolName: string;
  toolCallId: string;
  path?: string;
  oldText?: string;
}

export interface ShadowToolResultObservation {
  toolName: string;
  toolCallId?: string;
  isError: boolean;
}

export interface JevShadow {
  submit(request: ShadowRequest): boolean;
  observeToolCall(observation: ShadowToolCallObservation): void;
  observeToolResult(observation: ShadowToolResultObservation): void;
  shutdown(graceMs?: number): Promise<void>;
  drain(): Promise<void>;
  readonly inFlight: number;
}

export interface JevShadowOptions {
  client: JevClient;
  onEvidence?: (record: ShadowEvidence) => void | Promise<void>;
  confidenceThreshold?: number;
  timeoutMs?: number;
  sessionLimit?: number;
  labelWindow?: number;
  now?: () => number;
}

interface OpenSelection {
  request: ShadowRequest;
  evidence: ShadowEvidence;
  callsLeft: number;
}

interface PendingLabel {
  selection: OpenSelection;
  actualOrdinal: number;
}

/**
 * Session-scoped shadow controller. Remote decisions are evidence only: this
 * module cannot mutate tool inputs or files, and every failure becomes an
 * abstention-shaped metadata record.
 */
export function createJevShadow(options: JevShadowOptions): JevShadow {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_SHADOW_CONFIDENCE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHADOW_TIMEOUT_MS;
  const sessionLimit = options.sessionLimit ?? DEFAULT_SHADOW_SESSION_LIMIT;
  const labelWindow = options.labelWindow ?? DEFAULT_SHADOW_LABEL_WINDOW;
  const now = options.now ?? (() => Date.now());
  const onEvidence = options.onEvidence ?? (() => {});

  let submitted = 0;
  let stopped = false;
  let active: { controller: AbortController; promise: Promise<void>; request: ShadowRequest; startedAt: number; settled: boolean } | undefined;
  const selections: OpenSelection[] = [];
  const pendingLabels = new Map<string, PendingLabel>();

  function emit(record: ShadowEvidence): void {
    void Promise.resolve(onEvidence({ ...record })).catch(() => { /* evidence must not affect tool flow */ });
  }

  function finish(record: ShadowEvidence, request: ShadowRequest): void {
    emit(record);
    if (record.status === "selected") {
      selections.push({ request, evidence: record, callsLeft: labelWindow });
    }
  }

  function statusForError(error: unknown, timedOut: boolean): ShadowStatus {
    if (timedOut) return "timeout";
    const kind = (error as Partial<JevClientError> | undefined)?.kind;
    if (kind === "rate-limited") return "rate-limited";
    if (kind === "malformed") return "malformed";
    return "transport";
  }

  async function run(request: ShadowRequest, controller: AbortController, startedAt: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("shadow timeout"));
        }, timeoutMs);
      });
      const answer = await Promise.race([options.client.choose({ candidates: request.candidates, requestedEditText: request.requestedEditText }, controller.signal), timeout]);
      if (stopped || controller.signal.aborted) return;
      const validOrdinal = answer.choice === null || request.candidates.some((candidate) => candidate.ordinal === answer.choice);
      const confidence = answer.confidence;
      const base = {
        toolCallId: request.toolCallId,
        candidateCount: request.candidates.length,
        ...(confidence === undefined ? {} : { confidence }),
        ...(answer.model === undefined ? {} : { model: answer.model }),
        latencyMs: Math.max(0, now() - startedAt),
        labelStatus: "pending" as const,
      };
      if (!validOrdinal) {
        finish({ ...base, status: "malformed" }, request);
      } else if (answer.choice === null) {
        finish({ ...base, status: "abstain" }, request);
      } else if (confidence === undefined || !Number.isFinite(confidence) || confidence < confidenceThreshold) {
        // Abstention-shaped: a low-confidence choice is not evidence of selection.
        finish({ ...base, status: "low-confidence" }, request);
      } else {
        finish({ ...base, selectedOrdinal: answer.choice, status: "selected" }, request);
      }
    } catch (error) {
      if (stopped && controller.signal.aborted) return;
      finish({
        toolCallId: request.toolCallId,
        candidateCount: request.candidates.length,
        latencyMs: Math.max(0, now() - startedAt),
        status: statusForError(error, timedOut),
        labelStatus: "pending",
      }, request);
    } finally {
      if (timer) clearTimeout(timer);
      if (active?.controller === controller) {
        active.settled = true;
        active = undefined;
      }
    }
  }

  return {
    submit(request): boolean {
      if (stopped || active || submitted >= sessionLimit) return false;
      if (request.candidates.length < 2 || request.candidates.length > 5) return false;
      submitted++;
      const controller = new AbortController();
      const startedAt = now();
      const promise = run(request, controller, startedAt);
      active = { controller, promise, request, startedAt, settled: false };
      void promise.catch(() => { /* run converts failures to safe evidence */ });
      return true;
    },

    observeToolCall(observation): void {
      if (observation.toolName !== "edit" || !observation.path || !observation.oldText) return;
      if (pendingLabels.has(observation.toolCallId)) return; // never overwrite
      for (const selection of Array.from(selections)) {
        selection.callsLeft--;
        if (selection.callsLeft < 0) {
          selections.splice(selections.indexOf(selection), 1);
        }
      }
      // Exact, globally unique match only: the retry's oldText must equal
      // exactly one open candidate window across all selections. Anything
      // ambiguous or substring-based stays unlabeled.
      const matches = selections
        .filter((selection) => selection.request.path === observation.path)
        .flatMap((selection) => selection.request.candidates
          .filter((candidate) => candidate.window === observation.oldText)
          .map((candidate) => ({ selection, actualOrdinal: candidate.ordinal })));
      if (matches.length !== 1) return;
      pendingLabels.set(observation.toolCallId, { selection: matches[0]!.selection, actualOrdinal: matches[0]!.actualOrdinal });
    },

    observeToolResult(observation): void {
      if (observation.toolName !== "edit" || !observation.toolCallId) return;
      const pending = pendingLabels.get(observation.toolCallId);
      pendingLabels.delete(observation.toolCallId);
      if (!pending || observation.isError) return;
      const index = selections.indexOf(pending.selection);
      if (index !== -1) selections.splice(index, 1);
      emit({
        ...pending.selection.evidence,
        latencyMs: pending.selection.evidence.latencyMs,
        labelStatus: pending.selection.evidence.selectedOrdinal === pending.actualOrdinal
          ? "provisional-correct"
          : "provisional-incorrect",
      });
    },

    async shutdown(graceMs = 25): Promise<void> {
      stopped = true;
      if (!active) return;
      const snapshot = active;
      snapshot.controller.abort();
      emit({
        toolCallId: snapshot.request.toolCallId,
        candidateCount: snapshot.request.candidates.length,
        latencyMs: Math.max(0, now() - snapshot.startedAt),
        status: "cancelled",
        labelStatus: "pending",
      });
      await Promise.race([
        snapshot.promise.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, graceMs))),
      ]);
      if (active === snapshot) active = undefined;
    },

    async drain(): Promise<void> {
      await active?.promise;
    },

    get inFlight(): number {
      return active ? 1 : 0;
    },
  };
}
