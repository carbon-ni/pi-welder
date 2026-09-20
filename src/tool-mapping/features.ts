/**
 * TASK-0036 — closed value-shape features.
 *
 * Every feature is a small, closed observation derived locally from a value.
 * Raw values, paths, commands, source, credentials, and conversation never
 * appear in a request, log, or evidence record.
 */

export type ValueShape = "path" | "prose" | "code" | "shell" | "collection" | "numeric" | "boolean" | "value";

export interface ValueFeatures {
  kind: "string" | "number" | "boolean" | "array";
  shape: ValueShape;
  lengthBucket: "empty" | "short" | "medium" | "long" | "huge";
  tokenBucket: "zero" | "one" | "few" | "several" | "many";
  /** Arrays only: bounded item-count bucket. */
  itemBucket?: "one" | "few" | "several" | "many";
}

/** Strong shell syntax; a bare `;` is ambiguous with code, so it is not strong. */
const SHELL_OPERATORS = /[|]|&&|\|\||\$\(|`|(>>|>|<)/;
const CODE_MARKERS = /[{}();=]|=>|\bfunction\b|\bimport\b|\bconst\b|\blet\b|\bclass\b/;
const PATH_LIKE = /^(~\/|\.{1,2}\/|\/)/;
const PATH_SEGMENTS = /^[A-Za-z0-9._@%+-]+(\/[A-Za-z0-9._@%+-]+)+$/;

function lengthBucketOf(length: number): ValueFeatures["lengthBucket"] {
  if (length === 0) return "empty";
  if (length <= 16) return "short";
  if (length <= 64) return "medium";
  if (length <= 256) return "long";
  return "huge";
}

function tokenBucketOf(count: number): ValueFeatures["tokenBucket"] {
  if (count === 0) return "zero";
  if (count === 1) return "one";
  if (count <= 3) return "few";
  if (count <= 8) return "several";
  return "many";
}

function itemBucketOf(count: number): ValueFeatures["itemBucket"] {
  if (count <= 1) return "one";
  if (count <= 4) return "few";
  if (count <= 16) return "several";
  return "many";
}

export function featuresOfValue(value: unknown): ValueFeatures {
  if (typeof value === "number") {
    return { kind: "number", shape: "numeric", lengthBucket: lengthBucketOf(String(value).length), tokenBucket: "one" };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", shape: "boolean", lengthBucket: "short", tokenBucket: "one" };
  }
  if (Array.isArray(value)) {
    return { kind: "array", shape: "collection", lengthBucket: lengthBucketOf(value.length), tokenBucket: tokenBucketOf(value.length), itemBucket: itemBucketOf(value.length) };
  }

  const text = typeof value === "string" ? value : "";
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const lines = text.split("\n");
  const shell = SHELL_OPERATORS.test(trimmed);
  const pathLike = (PATH_LIKE.test(trimmed) || PATH_SEGMENTS.test(trimmed)) && !shell && !/\s/.test(trimmed);
  const code = !shell && !pathLike && (CODE_MARKERS.test(trimmed) || /;\s*$/.test(trimmed));
  const prose = !shell && !pathLike && !code && (tokens.length >= 6 || (lines.length > 1 && tokens.length >= 4));

  const shape: ValueShape = shell ? "shell" : pathLike ? "path" : code ? "code" : prose ? "prose" : "value";
  return { kind: "string", shape, lengthBucket: lengthBucketOf(text.length), tokenBucket: tokenBucketOf(tokens.length) };
}
