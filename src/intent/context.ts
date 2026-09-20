/**
 * TASK-0029 — pre-failure structural context for intent-hypothesis evaluation.
 *
 * Only pre-failure evidence may enter a request: the attempted tool, the
 * argument key/type shape, the failure class, and a bounded history of prior
 * tool names + outcomes. No paths, source, commands, edit text, credentials,
 * or conversation text. No event after the failure is ever included.
 */

export const MAX_PRIOR_TOOLS = 4;

export type ValueShape = "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined";

export interface PriorToolObservation {
  name: string;
  outcome: "ok" | "error";
}

export interface IntentContext {
  family: FailureFamily;
  attemptedTool: string;
  /** Argument key names only; never values. */
  argKeys: string[];
  /** Key -> value TYPE shape (e.g. path: "string", edits: "array"). */
  argTypes: Record<string, ValueShape>;
  failureClass: string;
  priorTools: PriorToolObservation[];
}

export type FailureFamily = "missing-read" | "ambiguous-edit" | "edit-mismatch" | "invalid-shape";

/** Classifies a failure into a family from tool + error text (no raw text kept). */
export function classifyFailureFamily(toolName: string, errorText: string, input: Record<string, unknown>): FailureFamily | undefined {
  const text = errorText.toLowerCase();
  if (toolName === "read" && (text.includes("enoent") || text.includes("no such file"))) return "missing-read";
  if (toolName === "edit" && /found \d+ occurrences/.test(text)) return "ambiguous-edit";
  if (toolName === "edit" && (text.includes("could not find") || text.includes("must match exactly"))) return "edit-mismatch";
  const schemaLike = /\b(schema|invalid|required field|expected|unexpected|missing required)\b/.test(text) || !("edits" in input) && toolName === "edit";
  if (schemaLike && !(toolName === "edit" && ("edits" in input))) return "invalid-shape";
  return undefined;
}

/** Failure class token (closed vocabulary) derived from tool + family. */
export function failureClassOf(family: FailureFamily, toolName: string): string {
  switch (family) {
    case "missing-read": return "read.path-missing";
    case "ambiguous-edit": return "edit.oldtext-ambiguous";
    case "edit-mismatch": return "edit.oldtext-not-found";
    case "invalid-shape": return `${toolName}.shape-invalid`;
  }
}

export function valueShape(value: unknown): ValueShape {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return (typeof value === "object" || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ? (typeof value as ValueShape)
    : "undefined";
}

export function argShapeOf(input: Record<string, unknown>): { argKeys: string[]; argTypes: Record<string, ValueShape> } {
  const argKeys = Object.keys(input).sort();
  const argTypes: Record<string, ValueShape> = {};
  for (const key of argKeys) argTypes[key] = valueShape(input[key]);
  return { argKeys, argTypes };
}

/** Bounded prior-tool history; only names and outcomes. */
export function boundPriorTools(observations: readonly PriorToolObservation[]): PriorToolObservation[] {
  return observations.slice(-MAX_PRIOR_TOOLS);
}

/** Serialized request state; asserts only structural fields are present. */
export function buildIntentState(context: IntentContext): Record<string, unknown> {
  return {
    family: context.family,
    attemptedTool: context.attemptedTool,
    argKeys: context.argKeys,
    argTypes: context.argTypes,
    failureClass: context.failureClass,
    priorTools: context.priorTools,
  };
}
