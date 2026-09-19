/**
 * TASK-0022 — missing-read path repair: eligibility, bounded Jev request,
 * selection validation, and transparent path mutation.
 *
 * Jev never generates paths. The request carries only the requested relative
 * path plus bounded candidate relative paths — no contents, windows,
 * credentials, absolute paths, or conversation payload. One bounded request,
 * 2-second timeout, zero retries. Before mutating `event.input.path`, the
 * selected candidate is revalidated for containment and readability.
 */

import type { FileSystem } from "../infra/filesystem.ts";
import type { JevClient, JevPromptSpec, JevSelectionRequest, JevSelectionResponse } from "../infra/typesafe.ts";
import { generateReadPathCandidates, validateCandidatePath, type CandidatePath } from "./candidates.ts";
import { READ_PATH_GATE } from "./evidence-gate.ts";

export const READ_PATH_TIMEOUT_MS = 2_000;

/**
 * Read-path question/instructions. Paths, not edit targets: the model ranks
 * relative candidate paths and abstains when none is supported.
 */
export const READ_PATH_PROMPT: JevPromptSpec = {
  instructions:
    "A read requested a file path that does not exist. Choose the candidate relative path most likely to be the intended file, " +
    "using the requested path and the candidate paths. Choose abstain when the evidence is insufficient.",
  abstainCriteria: "No candidate path is sufficiently supported; do not select one.",
  candidateCriteria: (ordinal) => `Candidate ${ordinal}`,
};

export interface ReadPathPlan {
  requestedPath: string;
  candidates: CandidatePath[];
}

export type ReadPathStatus =
  | "selected"
  | "abstain"
  | "low-confidence"
  | "malformed"
  | "timeout"
  | "transport"
  | "rate-limited"
  | "cancelled";

/** Eligibility: a read call whose path is string-shaped and missing nearby. */
export async function planReadPathRepair(options: {
  toolInput: Record<string, unknown>;
  cwd: string;
  fileSystem?: FileSystem;
}): Promise<ReadPathPlan | undefined> {
  const requestedPath = options.toolInput.path;
  if (typeof requestedPath !== "string") return undefined;
  const candidates = await generateReadPathCandidates({
    cwd: options.cwd,
    requestedPath,
    fileSystem: options.fileSystem,
  });
  if (!candidates) return undefined;
  return { requestedPath, candidates };
}

/** Jev request: candidate ordinals with their relative paths, nothing else. */
export function buildReadPathRequest(plan: ReadPathPlan): JevSelectionRequest {
  return {
    candidates: plan.candidates.map((candidate) => ({ ordinal: candidate.ordinal, window: candidate.path })),
    requestedEditText: plan.requestedPath,
  };
}

/** Known-ordinal selection at or above the predeclared confidence threshold. */
export function selectReadPath(plan: ReadPathPlan, answer: JevSelectionResponse): CandidatePath | undefined {
  if (answer.choice === null) return undefined;
  const candidate = plan.candidates.find((entry) => entry.ordinal === answer.choice);
  if (!candidate) return undefined;
  const confidence = answer.confidence;
  if (confidence === undefined || !Number.isFinite(confidence) || confidence < READ_PATH_GATE.confidenceThreshold) {
    return undefined;
  }
  return candidate;
}

/** Revalidates a selected ordinal immediately before mutation. */
export async function validateReadPathSelection(options: {
  plan: ReadPathPlan;
  ordinal: number;
  cwd: string;
  fileSystem?: FileSystem;
}): Promise<string | undefined> {
  const candidate = options.plan.candidates.find((entry) => entry.ordinal === options.ordinal);
  if (!candidate) return undefined;
  return validateCandidatePath({ cwd: options.cwd, candidatePath: candidate.path, fileSystem: options.fileSystem });
}

export interface ReadPathSelectionResult {
  status: ReadPathStatus;
  selectedOrdinal?: number;
  selectedPath?: string;
  confidence?: number;
  latencyMs: number;
  model?: string;
}

/** One bounded request, zero retries; every failure leaves the call unchanged. */
export async function runReadPathSelection(options: {
  client: JevClient;
  plan: ReadPathPlan;
  now?: () => number;
  timeoutMs?: number;
}): Promise<ReadPathSelectionResult> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? READ_PATH_TIMEOUT_MS;
  const controller = new AbortController();
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("read-path timeout"));
      }, timeoutMs);
    });
    const answer = await Promise.race([options.client.choose(buildReadPathRequest(options.plan), controller.signal), timeout]);
    const latencyMs = Math.max(0, now() - startedAt);
    const base = {
      latencyMs,
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      ...(answer.model === undefined ? {} : { model: answer.model }),
    };
    if (answer.choice === null) return { status: "abstain", ...base };
    if (!options.plan.candidates.some((candidate) => candidate.ordinal === answer.choice)) {
      return { status: "malformed", ...base };
    }
    const selected = selectReadPath(options.plan, answer);
    if (!selected) return { status: "low-confidence", ...base };
    return { status: "selected", selectedOrdinal: selected.ordinal, selectedPath: selected.path, ...base };
  } catch (error) {
    const status: ReadPathStatus = timedOut ? "timeout" : statusForError(error);
    return { status, latencyMs: Math.max(0, now() - startedAt) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statusForError(error: unknown): ReadPathStatus {
  const kind = (error as { kind?: string } | undefined)?.kind;
  if (kind === "rate-limited") return "rate-limited";
  if (kind === "malformed") return "malformed";
  return "transport";
}
