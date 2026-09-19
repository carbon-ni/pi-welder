/**
 * TASK-0022 — metadata-only read-path repair counters.
 *
 * Distinguishes eligibility, selection, abstention, low confidence, failures,
 * repairs, and provisional labels. Never stores or renders paths.
 */

import type { ReadPathStatus } from "./path-repair.ts";

export interface ReadPathState {
  eligible: number;
  selected: number;
  abstained: number;
  lowConfidence: number;
  failed: number;
  repaired: number;
  provisionalCorrect: number;
  provisionalIncorrect: number;
}

export function createReadPathState(): ReadPathState {
  return {
    eligible: 0,
    selected: 0,
    abstained: 0,
    lowConfidence: 0,
    failed: 0,
    repaired: 0,
    provisionalCorrect: 0,
    provisionalIncorrect: 0,
  };
}

/** Records one eligibility observation and its terminal status. */
export function recordReadPathSelection(state: ReadPathState, status: ReadPathStatus): void {
  state.eligible++;
  switch (status) {
    case "selected": state.selected++; break;
    case "abstain": state.abstained++; break;
    case "low-confidence": state.lowConfidence++; break;
    default: state.failed++; break;
  }
}

/** Records the outcome of an applied repair (provisional until reviewed). */
export function recordReadPathRepair(state: ReadPathState, correct: boolean): void {
  state.repaired++;
  if (correct) state.provisionalCorrect++;
  else state.provisionalIncorrect++;
}

/** Deterministic, metadata-only summary. */
export function summarizeReadPathState(state: ReadPathState): string {
  return [
    "read-path repair (metadata only)",
    `eligible            : ${state.eligible}`,
    `selected            : ${state.selected}`,
    `abstained           : ${state.abstained}`,
    `low-confidence      : ${state.lowConfidence}`,
    `failed              : ${state.failed}`,
    `repaired            : ${state.repaired}`,
    `provisional-correct : ${state.provisionalCorrect}`,
    `provisional-wrong   : ${state.provisionalIncorrect}`,
  ].join("\n");
}
