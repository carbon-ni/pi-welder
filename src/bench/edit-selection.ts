/**
 * TASK-0013 — bounded ambiguous-edit ordinal selection: safety-first offline
 * evaluation (contract v2; plan: first experiment is advisory).
 *
 * Responsibility boundary (learned from the failed exact-byte recovery — 1/9
 * acceptance): the model/classifier may ONLY return a known candidate ordinal
 * or abstain. It must never generate path, oldText, newText, or any content.
 * Candidates are generated deterministically from an in-memory snapshot; the
 * experiment performs no filesystem mutation, and auto-application stays out
 * of scope unless held-out precision meets the predeclared safety threshold.
 *
 * Predeclared before evaluation (not tuned afterwards):
 * - SAFETY_PRECISION_THRESHOLD = 0.99 — minimum held-out precision to promote
 *   toward auto-application scope (only with >= MIN_EVALUATION_SAMPLES).
 * - MIN_EVALUATION_SAMPLES = 30 — contract sample minimum per evaluation.
 * - REJECT_PRECISION_FLOOR = 0.5 — precision below this is a reject.
 * A wrong selection is a hard safety failure, not a soft penalty.
 */

import type { ModelClient } from "./runner.ts";

export const SAFETY_PRECISION_THRESHOLD = 0.99;
export const MIN_EVALUATION_SAMPLES = 30;
export const REJECT_PRECISION_FLOOR = 0.5;

// --- deterministic candidate generator ------------------------------------------

export interface EditCandidate {
  ordinal: number;
  offset: number;
  length: number;
  indent: string;
}

/** Exact, non-overlapping occurrences of `oldText` in document order. Deterministic. */
export function generateCandidates(content: string, oldText: string): EditCandidate[] {
  if (oldText.length === 0) return [];
  const candidates: EditCandidate[] = [];
  let from = 0;
  while (true) {
    const offset = content.indexOf(oldText, from);
    if (offset === -1) break;
    const lineStart = content.lastIndexOf("\n", offset) + 1;
    const indent = content.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
    candidates.push({ ordinal: candidates.length + 1, offset, length: oldText.length, indent });
    from = offset + oldText.length;
  }
  return candidates;
}

// --- selection schema ------------------------------------------------------------

export type SelectionOutput = { ordinal: number } | { abstain: true };

const FORBIDDEN_FIELDS: readonly string[] = ["oldText", "newText", "path", "content", "command"];

/**
 * Strict schema: `{"ordinal": n}` with 1..maxOrdinal, or `{"abstain": true}`.
 * Anything else — unparseable text, out-of-range ordinal, or any content/path
 * field — is treated as abstain and flagged as a schema violation.
 */
export function parseSelection(raw: string, maxOrdinal: number): { selection: SelectionOutput; schemaViolation: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { selection: { abstain: true }, schemaViolation: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { selection: { abstain: true }, schemaViolation: true };
  }
  const record = parsed as Record<string, unknown>;
  if (FORBIDDEN_FIELDS.some((field) => record[field] !== undefined)) {
    return { selection: { abstain: true }, schemaViolation: true };
  }
  if (record["abstain"] === true && Object.keys(record).length === 1) {
    return { selection: { abstain: true }, schemaViolation: false };
  }
  const ordinal = record["ordinal"];
  if (
    Object.keys(record).length === 1 &&
    typeof ordinal === "number" &&
    Number.isInteger(ordinal) &&
    ordinal >= 1 &&
    ordinal <= maxOrdinal
  ) {
    return { selection: { ordinal }, schemaViolation: false };
  }
  return { selection: { abstain: true }, schemaViolation: true };
}

// --- selectors -------------------------------------------------------------------

export interface EditCase {
  caseId: string;
  candidates: EditCandidate[];
  oldText: string;
}

export interface EditSelector {
  id: string;
  select(selectionCase: EditCase): Promise<SelectionOutput>;
}

export interface SelectorMetrics {
  tokens: number;
  latencyMs: number;
  schemaViolations: number;
}

export interface ModelEditSelector extends EditSelector {
  /** Accumulated per-evaluation run metrics (tokens/latency/violations). */
  runMetrics: SelectorMetrics;
}

export const ALWAYS_ABSTAIN: EditSelector = {
  id: "always-abstain",
  select: async () => ({ abstain: true }),
};

/**
 * Deterministic similarity ranking: majority indentation wins, then document
 * order. No model, no randomness.
 */
export function similarityRankSelector(): EditSelector {
  return {
    id: "similarity-rank",
    select: async (selectionCase) => {
      const { candidates } = selectionCase;
      if (candidates.length === 0) return { abstain: true };
      const byIndent = new Map<string, number>();
      for (const candidate of candidates) {
        byIndent.set(candidate.indent, (byIndent.get(candidate.indent) ?? 0) + 1);
      }
      let bestIndent = candidates[0]!.indent;
      let bestCount = -1;
      for (const [indent, count] of byIndent) {
        if (count > bestCount) {
          bestIndent = indent;
          bestCount = count;
        }
      }
      const match = candidates.find((candidate) => candidate.indent === bestIndent);
      return match ? { ordinal: match.ordinal } : { abstain: true };
    },
  };
}

/**
 * Bounded model selector: exactly one client call per case; strict
 * ordinal-or-abstain schema; per-run tokens/latency/violations recorded.
 */
export function createModelSelector(client: ModelClient, id = "model-ordinal"): ModelEditSelector {
  const runMetrics: SelectorMetrics = { tokens: 0, latencyMs: 0, schemaViolations: 0 };
  return {
    id,
    runMetrics,
    select: async (selectionCase) => {
      const listing = selectionCase.candidates
        .map((candidate) => `${candidate.ordinal}: indent=${JSON.stringify(candidate.indent)}`)
        .join("; ");
      const response = await client.complete({
        toolName: "edit-candidate-selection",
        messages: [
          {
            role: "system",
            content:
              "You are choosing among pre-generated exact candidates for an ambiguous edit. " +
              'Reply with ONLY {"ordinal": n} using one of the listed ordinals, or {"abstain": true}. ' +
              "Never generate text content, paths, or code.",
          },
          { role: "user", content: `oldText occurrences:\n${listing}\nRespond with the best ordinal or abstain.` },
        ],
      });
      runMetrics.tokens += response.tokens;
      runMetrics.latencyMs += response.latencyMs;
      const { selection, schemaViolation } = parseSelection(response.content, selectionCase.candidates.length);
      if (schemaViolation) runMetrics.schemaViolations++;
      return selection;
    },
  };
}

// --- evaluation ------------------------------------------------------------------

export interface SelectionEvalResult {
  selectorId: string;
  total: number;
  selected: number;
  correct: number;
  wrong: number;
  abstained: number;
  schemaViolations: number;
  precision: number;
  coverage: number;
  abstentionRate: number;
  latencyMs: number;
  tokens: number;
  costUsd: number;
}

export interface AmbiguousEditCase extends EditCase {
  /** Ground truth fixed by the fixture author before evaluation. */
  expectedOrdinal: number;
  /** In-memory snapshot only; never read from or written to disk. */
  content: string;
}

export async function evaluateSelector(cases: readonly AmbiguousEditCase[], selector: EditSelector): Promise<SelectionEvalResult> {
  const result: SelectionEvalResult = {
    selectorId: selector.id,
    total: cases.length,
    selected: 0,
    correct: 0,
    wrong: 0,
    abstained: 0,
    schemaViolations: 0,
    precision: 0,
    coverage: 0,
    abstentionRate: 0,
    latencyMs: 0,
    tokens: 0,
    costUsd: 0,
  };
  const modelMetrics = "runMetrics" in selector ? (selector as ModelEditSelector).runMetrics : undefined;

  for (const evaluationCase of cases) {
    const selection = await selector.select(evaluationCase);
    if ("abstain" in selection) {
      result.abstained++;
      continue;
    }
    result.selected++;
    if (selection.ordinal === evaluationCase.expectedOrdinal) result.correct++;
    else result.wrong++; // hard safety failure
  }

  if (modelMetrics) {
    result.tokens = modelMetrics.tokens;
    result.latencyMs = modelMetrics.latencyMs;
    result.schemaViolations = modelMetrics.schemaViolations;
    result.costUsd = modelMetrics.tokens * 0.001; // deterministic fake rate for offline reporting
  }

  result.precision = result.selected === 0 ? 0 : result.correct / result.selected;
  result.coverage = result.total === 0 ? 0 : result.selected / result.total;
  result.abstentionRate = result.total === 0 ? 0 : result.abstained / result.total;
  return result;
}

// --- decision --------------------------------------------------------------------

export interface SelectionDecision {
  decision: "promote" | "advisory" | "reject";
  reason: string;
  threshold: number;
  samples: number;
}

/**
 * Predeclared decision rule:
 * - reject: any schema violations (content/path generation attempts) or best
 *   precision < REJECT_PRECISION_FLOOR.
 * - promote: best precision >= SAFETY_PRECISION_THRESHOLD AND samples >= MIN.
 * - advisory: everything else (including insufficient samples).
 */
export function decide(results: readonly SelectionEvalResult[], samples: number, options: { threshold?: number } = {}): SelectionDecision {
  const threshold = options.threshold ?? SAFETY_PRECISION_THRESHOLD;
  if (results.length === 0) {
    return { decision: "advisory", reason: "no-selector-results", threshold, samples };
  }
  const violating = results.reduce((sum, r) => sum + r.schemaViolations, 0);
  if (violating > 0) {
    return { decision: "reject", reason: `schema-violations:${violating} (content/path generation attempts)`, threshold, samples };
  }
  const best = results.reduce((a, b) => (b.precision > a.precision ? b : a));
  if (best.precision < REJECT_PRECISION_FLOOR) {
    return { decision: "reject", reason: `precision ${best.precision.toFixed(3)} below safety floor ${REJECT_PRECISION_FLOOR}`, threshold, samples };
  }
  if (samples < MIN_EVALUATION_SAMPLES) {
    return { decision: "advisory", reason: `insufficient-samples: ${samples} < ${MIN_EVALUATION_SAMPLES}`, threshold, samples };
  }
  if (best.precision >= threshold) {
    return { decision: "promote", reason: `precision ${best.precision.toFixed(3)} >= threshold ${threshold} at ${samples} samples`, threshold, samples };
  }
  return { decision: "advisory", reason: `precision ${best.precision.toFixed(3)} < threshold ${threshold}`, threshold, samples };
}
