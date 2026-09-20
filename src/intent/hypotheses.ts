/**
 * TASK-0029 — deterministic, case-specific intent hypotheses.
 *
 * Hypotheses are mutually exclusive causal claims about what the agent was
 * trying to do — never repair-rule names or policy decisions. Code generates
 * 2–4 claims per failure family plus "uncertain".
 *
 * Validity limit: ground truth is a FUTURE-BEHAVIOR PROXY taken from the first
 * later successful call; it is not verified causal intent. Claims in a family
 * are intended to be mutually exclusive, but real failures can plausibly
 * support more than one, so proxy agreement must not be read as intent
 * identification.
 */

import type { FailureFamily } from "./context.ts";

export interface IntentHypothesis {
  id: string;
  claim: string;
}

export const UNCERTAIN_HYPOTHESIS: IntentHypothesis = {
  id: "uncertain",
  claim: "None of these claims is supported by the pre-failure evidence.",
};

const FAMILY_HYPOTHESES: Record<FailureFamily, readonly IntentHypothesis[]> = {
  "missing-read": [
    { id: "intent.read-existing-file", claim: "The agent intended to read an existing file and the path it supplied was wrong or stale." },
    { id: "intent.create-then-read", claim: "The agent intended to create or change the file first rather than read it as it currently is." },
    { id: "intent.inspect-location", claim: "The agent intended to inspect a directory or listing rather than a file's contents." },
  ],
  "ambiguous-edit": [
    { id: "intent.one-occurrence-needs-context", claim: "The agent intended to change one specific occurrence and needed more surrounding context to locate it uniquely." },
    { id: "intent.different-occurrence", claim: "The agent intended a different occurrence than the one its locator matched." },
    { id: "intent.rewrite-region", claim: "The agent intended to rewrite a larger region rather than make a targeted edit." },
  ],
  "edit-mismatch": [
    { id: "intent.content-drifted", claim: "The agent intended to change text at that location, but the file content had drifted since the agent last saw it." },
    { id: "intent.different-location", claim: "The agent intended to change a different location than the one it described." },
    { id: "intent.inspect-before-editing", claim: "The agent intended to inspect the file again before applying any change." },
  ],
  "invalid-shape": [
    { id: "intent.same-operation-corrected", claim: "The agent intended the same operation and only the argument shape was wrong." },
    { id: "intent.different-operation", claim: "The agent intended a different operation on the same target than the tool it called." },
    { id: "intent.unrelated-continuation", claim: "The agent intended something other than recovering this operation after the shape error; its next successful action was unrelated work." },
  ],
};

/** Deterministic hypothesis set for a family (never includes uncertain). */
export function hypothesesFor(family: FailureFamily): readonly IntentHypothesis[] {
  return FAMILY_HYPOTHESES[family];
}

/** The later successful call, reduced to structural signals for labeling. */
export interface SuccessObservation {
  toolName: string;
  /** Edit success whose locator extends the failed locator (drift/context signal). */
  extendsFailedLocator?: boolean;
  /** Success used the same primary target (same path/argument target). */
  sameTarget?: boolean;
}

export type IntentLabel = string | "unresolvable";

const INSPECTION_TOOLS: ReadonlySet<string> = new Set(["bash", "ls", "find", "grep"]);

/**
 * Hidden ground truth: maps the later successful call to the hypothesis it
 * supports. Returns "unresolvable" when the evidence does not discriminate.
 */
export function labelFor(family: FailureFamily, success: SuccessObservation, failedTool?: string): IntentLabel {
  switch (family) {
    case "missing-read":
      if (success.toolName === "read") return "intent.read-existing-file";
      if (success.toolName === "write" || success.toolName === "edit") return "intent.create-then-read";
      if (INSPECTION_TOOLS.has(success.toolName)) return "intent.inspect-location";
      return "unresolvable";
    case "ambiguous-edit":
      if (success.toolName === "edit") return success.extendsFailedLocator ? "intent.one-occurrence-needs-context" : "intent.different-occurrence";
      if (success.toolName === "write") return "intent.rewrite-region";
      return "unresolvable";
    case "edit-mismatch":
      if (success.toolName === "edit") return success.extendsFailedLocator ? "intent.content-drifted" : "intent.different-location";
      if (success.toolName === "read") return "intent.inspect-before-editing";
      return "unresolvable";
    case "invalid-shape":
      return failedTool === undefined ? "unresolvable" : labelInvalidShape(failedTool, success);
  }
}

/** Labeling for invalid-shape needs the failed tool name to discriminate. */
export function labelInvalidShape(failedTool: string, success: SuccessObservation): IntentLabel {
  if (success.toolName === failedTool) return "intent.same-operation-corrected";
  if (success.sameTarget === true) return "intent.different-operation";
  return "intent.unrelated-continuation";
}

/** Request criteria: every hypothesis claim plus the explicit uncertain option. */
export function hypothesisCriteria(family: FailureFamily): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const hypothesis of hypothesesFor(family)) criteria[hypothesis.id] = hypothesis.claim;
  criteria[UNCERTAIN_HYPOTHESIS.id] = UNCERTAIN_HYPOTHESIS.claim;
  return criteria;
}

export const INTENT_QUESTION_INSTRUCTIONS =
  "A tool call failed. Based ONLY on the pre-failure context (attempted tool, argument shape, failure class, and prior tool outcomes), " +
  "choose the single hypothesis that best explains the agent's original intent, or uncertain when no hypothesis is supported. " +
  "Choose only from the listed criteria.";

/** Valid ids for a family (hypotheses + uncertain). */
export function validIntentIds(family: FailureFamily): ReadonlySet<string> {
  return new Set([...hypothesesFor(family).map((hypothesis) => hypothesis.id), UNCERTAIN_HYPOTHESIS.id]);
}
