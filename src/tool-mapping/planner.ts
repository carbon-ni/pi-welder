/**
 * TASK-0036 — schema-driven field-mapping planner.
 *
 * Generalizes TASK-0034/0035 without any alias list: for a malformed call, the
 * planner enumerates `{target tool, one-to-one field mapping}` hypotheses whose
 * mapped values satisfy the target schema unchanged. Values are never
 * transformed, duplicated, dropped, or invented; only keys and shapes leave the
 * process (and only in the offline evaluation).
 *
 * Public verification source: `src/schemas.ts` (the shipped runtime schema) plus
 * the required/optional split and capability class from `src/tool-routing/contracts.ts`.
 */

import { TOOL_CONTRACTS, type ToolContract } from "../tool-routing/contracts.ts";

export const MAX_INPUT_FIELDS = 5;
export const MAX_PLANS = 5;
export const MAX_TARGETS = 5;
export const MAX_VALUE_CHARS = 2_048;
export const MAX_COLLECTION_ITEMS = 64;
/** Target fields the planner understands; no unions or recursion in this pass. */
export const SUPPORTED_TYPES = ["string", "number", "boolean", "array"] as const;

export type SupportedType = (typeof SUPPORTED_TYPES)[number];
export type ValueKind = SupportedType | "object" | "null" | "undefined";

/**
 * Verified per-field constraints beyond the top-level type. Only constraints the
 * shipped tools actually enforce are listed:
 * - `bash.timeout` rejects non-finite, <= 0, and > 2^31-1 ms (pi's bash tool).
 * - `edit.edits` items must be `{ oldText: string, newText: string }` (pi's edit tool).
 * Adding a constraint for another tool is a registry entry, no alias list.
 */
export type FieldConstraint =
  | { kind: "number"; exclusiveMin?: number; max?: number }
  | { kind: "arrayItems"; items: Readonly<Record<string, "string" | "number" | "boolean">>; requireAll: boolean };

export const FIELD_CONSTRAINTS: Readonly<Record<string, FieldConstraint>> = Object.freeze({
  "bash.timeout": { kind: "number", exclusiveMin: 0, max: 2_147_483.647 },
  "edit.edits": { kind: "arrayItems", items: { oldText: "string", newText: "string" }, requireAll: true },
});

export function constraintFor(tool: string, field: string): FieldConstraint | undefined {
  return FIELD_CONSTRAINTS[`${tool}.${field}`];
}

/** Field-level constraint check used by revalidation. */
export function satisfiesConstraint(tool: string, field: string, value: unknown): boolean {
  const constraint = constraintFor(tool, field);
  if (constraint === undefined) return true;
  if (constraint.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (constraint.exclusiveMin !== undefined && value <= constraint.exclusiveMin) return false;
    if (constraint.max !== undefined && value > constraint.max) return false;
    return true;
  }
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const keys = Object.keys(item);
    if (constraint.requireAll && !Object.keys(constraint.items).every((key) => keys.includes(key))) return false;
    return keys.every((key) => {
      const expected = constraint.items[key];
      return expected !== undefined && valueKindOf((item as Record<string, unknown>)[key]) === expected;
    });
  });
}

export interface MappingPair {
  from: string;
  to: string;
}

export interface MappingPlan {
  ordinal: number;
  targetTool: string;
  pairs: MappingPair[];
  /** Canonical arguments built from unchanged values. Local only. */
  args: Record<string, unknown>;
}

export type PlanAbstentionReason =
  | "not-an-object"
  | "too-many-fields"
  | "unsupported-value"
  | "oversized-value"
  | "unsupported-schema"
  | "exact-canonical"
  | "no-plans"
  | "too-many-plans";

export interface PlanEnumeration {
  status: "plans" | "abstain";
  reason?: PlanAbstentionReason;
  /** Target tools whose canonical (identity) shape already matches: deterministic. */
  exactTargets: string[];
  plans: MappingPlan[];
}

export function valueKindOf(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : kind === "undefined" ? "undefined" : "object";
}

function isSupportedValue(value: unknown): value is string | number | boolean | unknown[] {
  const kind = valueKindOf(value);
  if (kind === "object" || kind === "null" || kind === "undefined") return false;
  if (kind === "number" && !Number.isFinite(value as number)) return false;
  return true;
}

/** Type-compatible target field for a value: same kind, no coercion. */
export function compatibleFields(contract: ToolContract, value: unknown): string[] {
  const kind = valueKindOf(value);
  if (kind === "object" || kind === "null" || kind === "undefined") return [];
  if (kind === "number" && !Number.isFinite(value as number)) return [];
  return Object.entries(contract.types)
    .filter(([, type]) => type === kind)
    .map(([field]) => field);
}

export interface PlannerOptions {
  /** Test/fixture hook; defaults to the verified local registry. */
  contracts?: ReadonlyMap<string, ToolContract>;
  maxPlans?: number;
}

function contractsOf(options: PlannerOptions): ReadonlyMap<string, ToolContract> {
  return options.contracts ?? TOOL_CONTRACTS;
}

/**
 * Deterministically revalidates a candidate mapping: every required target
 * field is present with the right type, every argument key is known, and no
 * value was changed, duplicated, or dropped.
 */
export function validatesMapping(contract: ToolContract, args: Record<string, unknown>, pairs: readonly MappingPair[], input: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  if (new Set(keys).size !== keys.length) return false;
  for (const key of keys) {
    const expected = contract.types[key];
    if (expected === undefined) return false;
    if (valueKindOf(args[key]) !== expected) return false;
    if (!satisfiesConstraint(contract.tool, key, args[key])) return false;
  }
  for (const required of contract.required) {
    if (!(required in args)) return false;
  }

  // Independent bijection enforcement: distinct sources AND distinct targets,
  // one pair per input field, one pair per produced argument key, same values.
  const sources = pairs.map((pair) => pair.from);
  const targets = pairs.map((pair) => pair.to);
  if (new Set(sources).size !== sources.length) return false;
  if (new Set(targets).size !== targets.length) return false;
  if (sources.length !== Object.keys(input).length) return false;
  if (targets.length !== keys.length) return false;
  if (!targets.every((target) => target in args)) return false;
  return pairs.every((pair) => Object.is(input[pair.from], args[pair.to]));
}

function isIdentityMapping(pairs: readonly MappingPair[]): boolean {
  return pairs.every((pair) => pair.from === pair.to);
}

/** All injective assignments of input fields onto compatible target fields. */
function enumerateAssignments(inputFields: readonly string[], contracts: ToolContract, input: Record<string, unknown>): MappingPair[][] {
  const results: MappingPair[][] = [];
  const used = new Set<string>();
  const current: MappingPair[] = [];

  const walk = (index: number): void => {
    if (results.length > MAX_PLANS) return; // bounded exploration
    if (index === inputFields.length) {
      results.push([...current]);
      return;
    }
    const from = inputFields[index]!;
    for (const to of compatibleFields(contracts, input[from])) {
      if (used.has(to)) continue;
      used.add(to);
      current.push({ from, to });
      walk(index + 1);
      current.pop();
      used.delete(to);
    }
  };

  walk(0);
  return results;
}

function planSignature(plan: MappingPlan): string {
  return `${plan.targetTool}:${plan.pairs.map((pair) => `${pair.from}>${pair.to}`).join(",")}`;
}

/**
 * Enumerates bounded `{target tool, mapping}` hypotheses.
 *
 * Abstains when the input is not a flat object of supported values, has more
 * than five fields, carries an unsupported/oversized value, any target schema
 * is unsupported, or more than five plans result. An exact canonical (identity)
 * match is deterministic and bypasses Jev entirely.
 */
export function planMappings(sourceTool: string | undefined, input: unknown, options: PlannerOptions = {}): PlanEnumeration {
  const empty: PlanEnumeration = { status: "abstain", exactTargets: [], plans: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...empty, reason: "not-an-object" };

  const record = input as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length > MAX_INPUT_FIELDS) return { ...empty, reason: "too-many-fields" };
  if (fields.length === 0) return { ...empty, reason: "no-plans" };

  for (const field of fields) {
    if (!isSupportedValue(record[field])) return { ...empty, reason: "unsupported-value" };
    const value = record[field];
    if (typeof value === "string" && value.length > MAX_VALUE_CHARS) return { ...empty, reason: "oversized-value" };
    if (Array.isArray(value) && value.length > MAX_COLLECTION_ITEMS) return { ...empty, reason: "oversized-value" };
  }

  const contracts = contractsOf(options);
  const source = sourceTool === undefined ? undefined : contracts.get(sourceTool);
  // The source tool's own canonical shape is a deterministic match, not a guess.
  if (source !== undefined && validatesMapping(source, record, fields.map((field) => ({ from: field, to: field })), record)) {
    return { ...empty, reason: "exact-canonical", exactTargets: [source.tool] };
  }

  const targets = [...contracts.values()].filter((contract) => contract.tool !== sourceTool).slice(0, MAX_TARGETS);
  if (targets.length === 0) return { ...empty, reason: "unsupported-schema" };

  const exactTargets: string[] = [];
  const plans: MappingPlan[] = [];
  for (const target of targets) {
    if (Object.values(target.types).some((type) => !(SUPPORTED_TYPES as readonly string[]).includes(type))) {
      // Only string/number/boolean/array fields are supported; anything else fails closed.
      return { ...empty, reason: "unsupported-schema" };
    }
    for (const pairs of enumerateAssignments(fields, target, record)) {
      const args: Record<string, unknown> = {};
      for (const pair of pairs) args[pair.to] = record[pair.from];
      if (!validatesMapping(target, args, pairs, record)) continue;
      if (isIdentityMapping(pairs)) {
        if (!exactTargets.includes(target.tool)) exactTargets.push(target.tool);
        continue;
      }
      plans.push({ ordinal: 0, targetTool: target.tool, pairs, args });
    }
  }

  if (exactTargets.length > 0) return { ...empty, reason: "exact-canonical", exactTargets };

  const unique = new Map<string, MappingPlan>();
  for (const plan of plans) if (!unique.has(planSignature(plan))) unique.set(planSignature(plan), plan);
  const ordered = [...unique.values()]
    .sort((left, right) => (planSignature(left) < planSignature(right) ? -1 : planSignature(left) > planSignature(right) ? 1 : 0))
    .map((plan, index) => ({ ...plan, ordinal: index + 1 }));

  if (ordered.length === 0) return { ...empty, reason: "no-plans" };
  const maxPlans = options.maxPlans ?? MAX_PLANS;
  if (ordered.length > maxPlans) return { ...empty, reason: "too-many-plans" };

  return { status: "plans", exactTargets: [], plans: ordered };
}

/** Plan ordinals plus `none`, the closed choice set for the judge. */
export function planOptions(count: number): string[] {
  return [...Array.from({ length: count }, (_, index) => `plan-${index + 1}`), "none"];
}

/** Canonical role names for a plan, e.g. `plan-2` -> `write.path=FROM`. */
export function planLabel(plan: MappingPlan): string {
  return `${plan.targetTool}: ${plan.pairs.map((pair) => `${pair.to}<-${pair.from}`).join(", ")}`;
}
