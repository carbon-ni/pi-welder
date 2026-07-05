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

/**
 * Apply the structural repairs that a single field value needs.
 * Returns [value, repairs]. Recurses into arrays/objects after type changes.
 *
 * Ordering principle for array fields receiving a string:
 *   parse-json  →  split  →  wrap residual single value.
 * A value that emerged from JSON parsing is the model's final intent and is
 * NEVER re-wrapped. A string that looks like a botched JSON literal
 * (`[...`/`{...` that failed to parse) is left untouched for the tool to reject.
 */
function repairValue(value: unknown, key: string, fieldPath: string): [unknown, Repair[]] {
  const repairs: Repair[] = [];

  // 1. clean-path — unwrap markdown auto-links + trim (paths only)
  if (isPathField(key) && typeof value === "string") {
    const cleaned = unwrapMarkdownLink(value).trim();
    if (cleaned !== value) {
      value = cleaned;
      repairs.push({ field: fieldPath, action: "clean-path" });
    }
  }

  // 2. parse-json — stringified arrays/objects → real structures.
  //    If this fires, the parsed structure is final: skip wrap/split below.
  let parsedFromString = false;
  if (typeof value === "string") {
    const parsed = tryParseJsonString(value);
    if (parsed !== value) {
      value = parsed;
      parsedFromString = true;
      repairs.push({ field: fieldPath, action: "parse-json" });
    }
  }

  // 3. array-field structure resolution — only when not already resolved by
  //    parse-json and not already an array.
  if (isArrayField(key) && !parsedFromString && !Array.isArray(value)) {
    if (typeof value === "string") {
      const split = trySplitStringToArray(value);
      if (Array.isArray(split)) {
        value = split;
        repairs.push({ field: fieldPath, action: "split-string" });
      } else if (!looksLikeJsonLiteral(value)) {
        value = [value];
        repairs.push({ field: fieldPath, action: "wrap-array" });
      }
      // else: a botched JSON literal (`[oops`) — leave for the tool to reject.
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      value = [value];
      repairs.push({ field: fieldPath, action: "wrap-object-array" });
    } else if (value !== null && value !== undefined) {
      value = [value];
      repairs.push({ field: fieldPath, action: "wrap-array" });
    }
  }

  // 4. coerce-boolean
  if (isBooleanField(key) && typeof value === "string") {
    const coerced = coerceToBoolean(value);
    if (coerced !== value) {
      value = coerced;
      repairs.push({ field: fieldPath, action: "coerce-boolean" });
    }
  }

  // 5. coerce-number
  if (isNumberField(key) && typeof value === "string") {
    const coerced = coerceToNumber(value);
    if (coerced !== value) {
      value = coerced;
      repairs.push({ field: fieldPath, action: "coerce-number" });
    }
  }

  // 6. strip-extra-props — enforce array-item schemas
  if (Array.isArray(value) && ARRAY_ITEM_SCHEMAS.has(key)) {
    const [cleaned, changed] = stripExtraProps(value, key);
    if (changed) {
      value = cleaned;
      repairs.push({ field: fieldPath, action: "strip-extra-props" });
    }
  }

  // 7. recurse into structures after type changes settle
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const [repaired, itemRepairs] = repairValue(value[i], "[item]", `${fieldPath}[${i}]`);
      items.push(repaired);
      repairs.push(...itemRepairs);
    }
    value = items;
  } else if (typeof value === "object" && value !== null) {
    const [repairedObj, nested] = repairObject(value as Record<string, unknown>, fieldPath);
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
export function repairArgs(input: Record<string, unknown>): RepairResult {
  const result: Record<string, unknown> = {};
  const repairs: Repair[] = [];

  for (const [key, value] of Object.entries(input)) {
    const fieldPath = `input.${key}`;

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

    const [repaired, fieldRepairs] = repairValue(value, key, fieldPath);
    result[key] = repaired;
    repairs.push(...fieldRepairs);
  }

  const defaults = applyRelationalDefaults(result);
  for (const k of Object.keys(defaults.result)) result[k] = defaults.result[k];
  repairs.push(...defaults.repairs);

  return { result, repairs };
}

/** Internal: repair a nested object in place (recursion target). */
function repairObject(obj: Record<string, unknown>, parentPath: string): [Record<string, unknown>, Repair[]] {
  const result: Record<string, unknown> = {};
  const repairs: Repair[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = `${parentPath}.${key}`;
    if (CONTENT_FIELDS.has(key)) {
      result[key] = value == null ? "" : value;
      continue;
    }
    if (value === null) {
      repairs.push({ field: fieldPath, action: "strip-null" });
      continue;
    }
    if (isNullLikeString(value)) {
      repairs.push({ field: fieldPath, action: "strip-null-like" });
      continue;
    }
    const [repaired, fieldRepairs] = repairValue(value, key, fieldPath);
    result[key] = repaired;
    repairs.push(...fieldRepairs);
  }
  return [result, repairs];
}
