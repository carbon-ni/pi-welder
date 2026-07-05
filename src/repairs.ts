/**
 * The repair engine — pure structural fixes for recurring LLM tool-calling
 * mistakes, applied before a tool runs.
 *
 * Contract: parse → validate → repair only what would fail. Valid input
 * passes through byte-identical. Content fields (command, code, oldText…)
 * are NEVER transformed; their null values become "" so the tool's own
 * validation surfaces a clear error rather than crashing on undefined.
 *
 * No I/O, no side effects, fully deterministic — see repairs.test.ts.
 */

import {
  PATH_FIELDS,
  ARRAY_FIELDS,
  BOOLEAN_FIELDS,
  NUMBER_FIELDS,
  CONTENT_FIELDS,
  ARRAY_ITEM_SCHEMAS,
  NULL_LIKE_STRINGS,
  TRUTHY_STRINGS,
  FALSY_STRINGS,
} from "./fields.ts";

export type RepairAction =
  | "strip-null"
  | "strip-null-like"
  | "clean-path"
  | "parse-json"
  | "wrap-array"
  | "wrap-object-array"
  | "split-string"
  | "coerce-boolean"
  | "coerce-number"
  | "strip-extra-props"
  | "relational-default";

export interface Repair {
  field: string;
  action: RepairAction;
}

export interface RepairResult {
  result: Record<string, unknown>;
  repairs: Repair[];
}

// ─── Unit helpers (exported, each pure) ─────────────────────────────────

/** Unwrap only degenerate markdown auto-links where label == url-sans-protocol. */
export function unwrapMarkdownLink(value: string): string {
  if (typeof value !== "string") return value;
  const match = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return value;
  const label = match[1];
  const url = match[2];
  if (label === undefined || url === undefined) return value;
  const urlSansProto = url.replace(/^https?:\/\//, "").replace(/^file:\/\//, "");
  if (label === urlSansProto || label === url) return label;
  return value;
}

/** Parse a string into an array/object only if it's a JSON literal. */
export function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) return parsed;
    return value;
  } catch {
    return value;
  }
}

/** Coerce truthy/falsy string spellings to booleans. */
export function coerceToBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const norm = value.trim().toLowerCase();
  if (TRUTHY_STRINGS.has(norm)) return true;
  if (FALSY_STRINGS.has(norm)) return false;
  return value;
}

/** Coerce clearly-numeric strings to numbers; leave ambiguous ones alone. */
export function coerceToNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^-?\.?\d+(\.\d+)?$/.test(trimmed)) return value;
  const num = Number(trimmed);
  return Number.isNaN(num) ? value : num;
}

/** Recognize null-like string spellings the model emits instead of omitting. */
export function isNullLikeString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return NULL_LIKE_STRINGS.has(value.trim().toLowerCase());
}

/** Split a comma/space-delimited string into an array; leave paths alone. */
export function trySplitStringToArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return value; // JSON's job
  if (trimmed.includes("/") || trimmed.includes("\\")) return value; // path

  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  if (trimmed.includes(" ") && !trimmed.includes("http")) {
    const parts = trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return value;
}

// ─── Field classification (name + value → which repairs apply) ──────────

function isPathField(key: string): boolean {
  return PATH_FIELDS.has(key);
}

function isArrayField(key: string): boolean {
  if (ARRAY_FIELDS.has(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.endsWith("_list") || lower.endsWith("list") ||
    lower.endsWith("_names") || lower.endsWith("names") ||
    lower.endsWith("_items") || lower.endsWith("items") ||
    lower.endsWith("_array") || lower.endsWith("array")
  );
}

function isBooleanField(key: string): boolean {
  if (BOOLEAN_FIELDS.has(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.startsWith("is_") || lower.startsWith("has_") ||
    lower.startsWith("can_") || lower.endsWith("_flag")
  );
}

function isNumberField(key: string): boolean {
  if (NUMBER_FIELDS.has(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.startsWith("max") || lower.startsWith("min") ||
    lower.endsWith("_count") || lower.endsWith("_size") ||
    lower.endsWith("_index")
  );
}

// ─── Per-value repair dispatch ──────────────────────────────────────────

export interface RepairContext {
  key: string;
  fieldPath: string;
  parsedFromString: boolean;
  toolName?: string;
}

export interface RuleResult {
  value: unknown;
  repairs: Repair[];
  parsedFromString?: boolean;
}

export interface RepairOptions {
  toolName?: string;
  rules?: readonly RepairRule[];
}

export interface RepairRule {
  /** Stable registry name; array-shape may emit split/wrap repair actions. */
  action: RepairAction | "array-shape";
  repair(value: unknown, ctx: RepairContext): RuleResult;
}

const unchanged = (value: unknown): RuleResult => ({ value, repairs: [] });

export const repairRules: RepairRule[] = [
  {
    action: "clean-path",
    repair(value, ctx) {
      if (!isPathField(ctx.key) || typeof value !== "string") return unchanged(value);
      const cleaned = unwrapMarkdownLink(value).trim();
      if (cleaned === value) return unchanged(value);
      return { value: cleaned, repairs: [{ field: ctx.fieldPath, action: "clean-path" }] };
    },
  },
  {
    action: "parse-json",
    repair(value, ctx) {
      if (typeof value !== "string") return unchanged(value);
      const parsed = tryParseJsonString(value);
      if (parsed === value) return unchanged(value);
      return {
        value: parsed,
        parsedFromString: true,
        repairs: [{ field: ctx.fieldPath, action: "parse-json" }],
      };
    },
  },
  {
    action: "array-shape",
    repair(value, ctx) {
      if (!isArrayField(ctx.key) || ctx.parsedFromString || Array.isArray(value)) return unchanged(value);
      if (typeof value === "string") {
        const split = trySplitStringToArray(value);
        if (Array.isArray(split)) {
          return { value: split, repairs: [{ field: ctx.fieldPath, action: "split-string" }] };
        }
        if (looksLikeJsonLiteral(value)) return unchanged(value);
        return { value: [value], repairs: [{ field: ctx.fieldPath, action: "wrap-array" }] };
      }
      if (typeof value === "object" && value !== null) {
        return { value: [value], repairs: [{ field: ctx.fieldPath, action: "wrap-object-array" }] };
      }
      if (value === null || value === undefined) return unchanged(value);
      return { value: [value], repairs: [{ field: ctx.fieldPath, action: "wrap-array" }] };
    },
  },
  {
    action: "coerce-boolean",
    repair(value, ctx) {
      if (!isBooleanField(ctx.key) || typeof value !== "string") return unchanged(value);
      const coerced = coerceToBoolean(value);
      if (coerced === value) return unchanged(value);
      return { value: coerced, repairs: [{ field: ctx.fieldPath, action: "coerce-boolean" }] };
    },
  },
  {
    action: "coerce-number",
    repair(value, ctx) {
      if (!isNumberField(ctx.key) || typeof value !== "string") return unchanged(value);
      const coerced = coerceToNumber(value);
      if (coerced === value) return unchanged(value);
      return { value: coerced, repairs: [{ field: ctx.fieldPath, action: "coerce-number" }] };
    },
  },
  {
    action: "strip-extra-props",
    repair(value, ctx) {
      if (!Array.isArray(value) || !ARRAY_ITEM_SCHEMAS.has(ctx.key)) return unchanged(value);
      const [cleaned, changed] = stripExtraProps(value, ctx.key);
      if (!changed) return unchanged(value);
      return { value: cleaned, repairs: [{ field: ctx.fieldPath, action: "strip-extra-props" }] };
    },
  },
];

/**
 * Apply ordered structural repairs to a single field value.
 * Registry order is the extension point: parse-json → array-shape matters.
 */
function repairValue(value: unknown, key: string, fieldPath: string, options: RepairOptions): [unknown, Repair[]] {
  const repairs: Repair[] = [];
  const ctx: RepairContext = { key, fieldPath, parsedFromString: false, toolName: options.toolName };

  for (const rule of options.rules ?? repairRules) {
    const result = rule.repair(value, ctx);
    value = result.value;
    repairs.push(...result.repairs);
    ctx.parsedFromString = ctx.parsedFromString || result.parsedFromString === true;
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const [repaired, itemRepairs] = repairValue(value[i], "[item]", `${fieldPath}[${i}]`, options);
      items.push(repaired);
      repairs.push(...itemRepairs);
    }
    value = items;
  } else if (typeof value === "object" && value !== null) {
    const [repairedObj, nested] = repairObject(value as Record<string, unknown>, fieldPath, options);
    value = repairedObj;
    repairs.push(...nested);
  }

  return [value, repairs];
}

/** A string that opens like a JSON literal (a likely botched array/object). */
function looksLikeJsonLiteral(value: string): boolean {
  const t = value.trim();
  return t.startsWith("[") || t.startsWith("{");
}

/**
 * Enforce the allowed-property schema for a known array field's items.
 * Returns [cleaned, changed]. The caller emits the repair when changed.
 */
function stripExtraProps(items: unknown[], field: string): [unknown[], boolean] {
  const allowed = ARRAY_ITEM_SCHEMAS.get(field);
  if (!allowed) return [items, false];

  let changed = false;
  const cleaned = items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const obj = item as Record<string, unknown>;
    if (Object.keys(obj).every((k) => allowed.has(k))) return item;
    changed = true;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (allowed.has(k)) next[k] = v;
    return next;
  });
  return [cleaned, changed];
}

// ─── Relational defaults ────────────────────────────────────────────────

/**
 * Pairs of co-dependent numeric fields: if one is present, the missing one
 * gets a sensible default. Stops the model re-reading the same first page.
 */
export function applyRelationalDefaults(input: Record<string, unknown>): RepairResult {
  const result = { ...input };
  const repairs: Repair[] = [];
  if ("limit" in result && !("offset" in result)) {
    result.offset = 1;
    repairs.push({ field: "input.offset", action: "relational-default" });
  }
  if ("offset" in result && !("limit" in result)) {
    result.limit = 2000;
    repairs.push({ field: "input.limit", action: "relational-default" });
  }
  return { result, repairs };
}

// ─── Top-level entry: repair all fields of an args object ───────────────

/** Repair every field of a tool-call args object. Pure. */
export function repairArgs(input: Record<string, unknown>, options: RepairOptions = {}): RepairResult {
  const [result, repairs] = repairObjectFields(input, "input", options);

  const defaults = applyRelationalDefaults(result);
  for (const k of Object.keys(defaults.result)) result[k] = defaults.result[k];
  repairs.push(...defaults.repairs);

  return { result, repairs };
}

function repairObjectFields(
  obj: Record<string, unknown>,
  parentPath: string,
  options: RepairOptions,
): [Record<string, unknown>, Repair[]] {
  const result: Record<string, unknown> = {};
  const repairs: Repair[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = `${parentPath}.${key}`;

    // Content fields: never transformed; null → "" to avoid downstream crashes.
    if (CONTENT_FIELDS.has(key)) {
      result[key] = value == null ? "" : value;
      continue;
    }

    // strip-null — omit null optional fields entirely.
    if (value === null) {
      repairs.push({ field: fieldPath, action: "strip-null" });
      continue;
    }

    // strip-null-like — omit "null"/"none"/"n/a" string spellings.
    if (isNullLikeString(value)) {
      repairs.push({ field: fieldPath, action: "strip-null-like" });
      continue;
    }

    const [repaired, fieldRepairs] = repairValue(value, key, fieldPath, options);
    result[key] = repaired;
    repairs.push(...fieldRepairs);
  }

  return [result, repairs];
}

/** Internal: repair a nested object in place (recursion target). */
function repairObject(
  obj: Record<string, unknown>,
  parentPath: string,
  options: RepairOptions,
): [Record<string, unknown>, Repair[]] {
  return repairObjectFields(obj, parentPath, options);
}
