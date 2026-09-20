/**
 * TASK-0033 — deterministic argument-shape matching against closed tool
 * contracts.
 *
 * A match never reads argument values beyond their JSON type. Matching is
 * total and deterministic: one exact candidate is a deterministic routing
 * result, several candidates are an ambiguity, no candidate abstains.
 */

import { TOOL_CONTRACTS, capabilityOf, isRoutingAllowed, type Capability, type ToolContract } from "./contracts.ts";

export type ShapeValue = "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined";

/** Argument keys and their JSON value types. Values are never retained. */
export type ArgShape = Readonly<Record<string, ShapeValue>>;

export type MatchKind = "unique-exact" | "unique-incomplete" | "ambiguous" | "none";

export interface ToolMatch {
  tool: string;
  capability: Capability;
  /** True when the schema's required keys are all present and every key is known. */
  exact: boolean;
  routingAllowed: boolean;
}

export function shapeValueOf(value: unknown): ShapeValue {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ShapeValue;
}

export function shapeOf(args: Readonly<Record<string, unknown>>): ArgShape {
  const shape: Record<string, ShapeValue> = {};
  for (const key of Object.keys(args).sort()) shape[key] = shapeValueOf(args[key]);
  return shape;
}

/** All observed keys are known to the schema and type-compatible. */
function keysCompatible(contract: ToolContract, shape: ArgShape): boolean {
  for (const [key, value] of Object.entries(shape)) {
    const expected = contract.types[key];
    if (expected === undefined) return false; // unknown key
    if (value === "undefined" || value === "null" || value !== expected) return false;
  }
  return true;
}

function requiredPresent(contract: ToolContract, shape: ArgShape): boolean {
  return contract.required.every((key) => {
    const value = shape[key];
    return value !== undefined && value !== "undefined" && value === contract.types[key];
  });
}

/** A schema accepts the shape exactly, or is compatible but incomplete. */
export function schemaMatch(contract: ToolContract, shape: ArgShape): "exact" | "compatible" | "reject" {
  if (!keysCompatible(contract, shape)) return "reject";
  return requiredPresent(contract, shape) ? "exact" : "compatible";
}

/**
 * Candidate tools for a failed call. The source tool is excluded. Exact
 * matches win over compatible ones; a compatible match is never treated as a
 * deterministic repair.
 */
export function candidateMatches(sourceTool: string | undefined, shape: ArgShape): ToolMatch[] {
  const matches: ToolMatch[] = [];
  for (const [tool, contract] of TOOL_CONTRACTS.entries()) {
    if (tool === sourceTool) continue;
    const result = schemaMatch(contract, shape);
    if (result === "reject") continue;
    matches.push({ tool, capability: contract.capability, exact: result === "exact", routingAllowed: isRoutingAllowed(sourceTool, contract.capability) });
  }
  return matches;
}

/** Exact candidates win; compatible candidates are only a fallback set. */
export function primaryCandidates(matches: readonly ToolMatch[]): ToolMatch[] {
  const exact = matches.filter((match) => match.exact);
  return exact.length > 0 ? exact : [...matches];
}

export function classifyMatch(matches: readonly ToolMatch[]): MatchKind {
  const primary = primaryCandidates(matches);
  if (primary.length === 0) return "none";
  if (primary.length > 1) return "ambiguous";
  return primary[0]!.exact ? "unique-exact" : "unique-incomplete";
}

/** Deterministic ranking: fewer optional keys first, then tool name. */
export function rankCandidates(matches: readonly ToolMatch[]): ToolMatch[] {
  return [...matches].sort((left, right) => {
    const leftOptional = TOOL_CONTRACTS.get(left.tool)?.optional.length ?? 0;
    const rightOptional = TOOL_CONTRACTS.get(right.tool)?.optional.length ?? 0;
    return leftOptional - rightOptional || left.tool.localeCompare(right.tool);
  });
}

/**
 * Narrows candidates with the failure's declared missing field: a tool that
 * reports field D missing must require D. Falls back to the full set when the
 * narrowing would drop every candidate.
 */
export function narrowByDeclaredKeys(matches: readonly ToolMatch[], declaredKeys: readonly string[]): ToolMatch[] {
  if (declaredKeys.length === 0) return [...matches];
  const required = TOOL_CONTRACTS;
  const narrowed = matches.filter((match) => {
    const contract = required.get(match.tool);
    return contract !== undefined && declaredKeys.some((key) => contract.required.includes(key));
  });
  return narrowed.length > 0 ? narrowed : [...matches];
}

/** Deterministic baseline choice among candidates, or undefined when none. */
export function deterministicChoice(matches: readonly ToolMatch[]): string | undefined {
  return rankCandidates(primaryCandidates(matches))[0]?.tool;
}

export function capabilityOfTarget(target: string | undefined): Capability | undefined {
  return capabilityOf(target);
}

/** Bounded declared-key signal: keys the error names, never their values. */
export function declaredKeysOf(errorText: string | undefined): string[] {
  if (!errorText) return [];
  const keys = new Set<string>();
  for (const pattern of [/[Mm]issing required field[:\s]+([A-Za-z_][A-Za-z0-9_]*)/g, /[Uu]nknown (?:field|parameter|argument)[:\s]+([A-Za-z_][A-Za-z0-9_]*)/g, /[Ii]nvalid parameter(?: type)? for ([A-Za-z_][A-Za-z0-9_]*)/g]) {
    for (const match of errorText.matchAll(pattern)) {
      const key = match[1];
      if (key && key.length <= 40) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Explicit tool-validation phrases only. Generic words such as "schema" or
 * "expected <type>" are excluded because they appear in command output, test
 * names, and domain errors, which would inflate the mined denominator.
 */
const SCHEMA_FAILURE_PATTERNS: readonly RegExp[] = [
  /missing required field/i,
  /invalid parameter/i,
  /unknown (?:field|parameter|argument)/i,
  /unexpected (?:field|parameter|argument|property)/i,
  /must be of type/i,
  /required (?:field|parameter|argument)/i,
  /invalid type/i,
  /invalid_options/i,
];

/** Anchored Pi tool-arg validation header, e.g. `Validation failed for tool "write":`. */
export const PI_VALIDATION_HEADER = /^\s*Validation failed for tool "([A-Za-z0-9_.-]{1,60})":/;
/** A header-bearing message includes the rendered arguments and can be large. */
export const PI_VALIDATION_MAX_LENGTH = 50_000;
/** Legacy single-line messages are short. */
export const VALIDATION_ERROR_MAX_LENGTH = 300;

/** Tool named by the anchored Pi validation header, or undefined. */
export function piValidationTool(errorText: string | undefined): string | undefined {
  if (!errorText || errorText.length > PI_VALIDATION_MAX_LENGTH) return undefined;
  return PI_VALIDATION_HEADER.exec(errorText)?.[1];
}

/**
 * Tool-arg validation class only; execution and domain errors are excluded.
 *
 * A Pi validation failure starts with the anchored header and names the tool
 * it belongs to, so a header naming a different tool rejects the call. Without
 * a header the message must be short and single-line: multiline results are
 * command output (cargo "unexpected argument", vitest reports) and are never
 * mined.
 */
export function isValidationFailure(errorText: string | undefined, attemptedTool?: string): boolean {
  if (!errorText) return false;
  const headerTool = piValidationTool(errorText);
  if (headerTool !== undefined) return attemptedTool === undefined || headerTool === attemptedTool;
  if (errorText.includes("\n") || errorText.length > VALIDATION_ERROR_MAX_LENGTH) return false;
  return SCHEMA_FAILURE_PATTERNS.some((pattern) => pattern.test(errorText));
}
