import {
  NULL_LIKE_STRINGS,
  TRUTHY_STRINGS,
  FALSY_STRINGS,
} from "../fields.ts";

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

/** Split a comma/newline-delimited string into an array; leave paths alone on spaces. */
export function trySplitStringToArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return value; // JSON's job

  // Unambiguous delimiters: comma and newline. Split even when items are paths.
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  if (trimmed.includes("\n")) {
    const parts = trimmed.split("\n").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }

  // Ambiguous delimiter: space. A path may contain spaces, so do not guess.
  if (trimmed.includes("/") || trimmed.includes("\\")) return value; // path

  if (trimmed.includes(" ") && !trimmed.includes("http")) {
    const parts = trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return value;
}
