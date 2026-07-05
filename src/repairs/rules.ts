import {
  ARRAY_ITEM_SCHEMAS,
  isPathField,
  isArrayField,
  isBooleanField,
  isNumberField,
} from "../fields.ts";
import {
  coerceToBoolean,
  coerceToNumber,
  tryParseJsonString,
  trySplitStringToArray,
  unwrapMarkdownLink,
} from "./helpers.ts";
import type { RepairRule, RuleResult } from "./types.ts";

const unchanged = (value: unknown): RuleResult => ({ value, repairs: [] });

export const repairRules: readonly RepairRule[] = Object.freeze([
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
]);

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
