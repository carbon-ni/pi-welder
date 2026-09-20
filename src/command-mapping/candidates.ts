/**
 * TASK-0035 — bounded, value-free candidate command mappings.
 *
 * A non-exact malformed call may carry the intended bash command in a field
 * with an arbitrary name (`CMD`, `bash`, `execute`, `script`, ...). This module
 * enumerates at most five top-level string fields and derives a closed feature
 * set locally. Raw values are never returned in requests, logs, or evidence.
 */

/** Only these tools can carry a mistaken command shape. */
export const MAPPING_SOURCE_TOOLS = ["read", "write", "edit"] as const;

export const MAX_CANDIDATES = 5;
export const MAX_VALUE_CHARS = 512;
/** Pi's bash timeout is seconds; same canonical bound as the exact router. */
export const CANONICAL_TIMEOUT_MAX_SECONDS = 2_147_483.647;
/** Supporting field that may appear next to candidates. */
export const SUPPORTING_KEYS: ReadonlySet<string> = new Set(["timeout"]);

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;

export type CandidateShape = "shell-like" | "path-like" | "prose-like" | "value-like" | "other";

export interface CommandCandidate {
  ordinal: number;
  /** Key token only; never the value. */
  key: string;
  /** Local-only value used for labelling and size checks. Never transmitted. */
  value: string;
  shape: CandidateShape;
  lengthBucket: "short" | "medium" | "long" | "huge";
  tokenBucket: "one" | "few" | "several" | "many";
  lineBucket: "single" | "few" | "many";
  executableLike: boolean;
  shellOperator: boolean;
  redirection: boolean;
  assignment: boolean;
  pathLike: boolean;
  proseLike: boolean;
}

export type MappingAbstentionReason =
  | "not-a-source-tool"
  | "not-an-object"
  | "no-candidates"
  | "too-many-candidates"
  | "unsafe-key"
  | "oversized-value"
  | "unexplained-field"
  | "invalid-timeout";

export interface MappingEnumeration {
  status: "candidates" | "abstain";
  reason?: MappingAbstentionReason;
  candidates: CommandCandidate[];
  /** True when a canonical timeout accompanied the candidates. */
  canonicalTimeout: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimeout(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= CANONICAL_TIMEOUT_MAX_SECONDS;
}

const SHELL_OPERATORS = /[|;]|&&|\|\||\$\(|`/;
const REDIRECTIONS = /(>>|>|<)/;

function lengthBucketOf(length: number): CommandCandidate["lengthBucket"] {
  if (length <= 16) return "short";
  if (length <= 64) return "medium";
  if (length <= 256) return "long";
  return "huge";
}

function tokenBucketOf(count: number): CommandCandidate["tokenBucket"] {
  if (count <= 1) return "one";
  if (count <= 3) return "few";
  if (count <= 8) return "several";
  return "many";
}

function lineBucketOf(count: number): CommandCandidate["lineBucket"] {
  if (count <= 1) return "single";
  if (count <= 3) return "few";
  return "many";
}

/**
 * Local classification. Every returned flag is a small, closed observation; the
 * value itself is never part of the feature set.
 */
export function featuresOf(value: string): Omit<CommandCandidate, "ordinal" | "key" | "value"> {
  const trimmed = value.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const lines = value.split("\n");
  const leading = tokens[0] ?? "";
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed);
  const pathLike = /^(~\/|\.{1,2}\/|\/)/.test(leading) && !SHELL_OPERATORS.test(trimmed);
  const shellOperator = SHELL_OPERATORS.test(trimmed);
  const redirection = REDIRECTIONS.test(trimmed);
  const executableLike = /^[A-Za-z0-9_./-]+$/.test(leading) && !pathLike && leading.length > 0;
  const proseLike = tokens.length >= 6 && /[.?!]$/.test(trimmed) && /\s/.test(trimmed) && !shellOperator;

  const shape: CandidateShape = proseLike
    ? "prose-like"
    : pathLike
      ? "path-like"
      : executableLike || shellOperator || redirection || assignment
        ? "shell-like"
        : tokens.length <= 1
          ? "value-like"
          : "other";

  return {
    shape,
    lengthBucket: lengthBucketOf(value.length),
    tokenBucket: tokenBucketOf(tokens.length),
    lineBucket: lineBucketOf(lines.length),
    executableLike,
    shellOperator,
    redirection,
    assignment,
    pathLike,
    proseLike,
  };
}

/**
 * Enumerates at most five top-level non-empty string fields as command
 * hypotheses. Candidate order is alphabetical by key token, so ordinals are
 * deterministic and no alias list is required. Anything the judge cannot
 * explain — an unsafe key, an oversized value, a nested object/array, an extra
 * field that is not the canonical timeout, more than five candidates, or an
 * invalid timeout — abstains.
 */
export function enumerateCommandMapping(toolName: string, input: unknown): MappingEnumeration {
  if (!(MAPPING_SOURCE_TOOLS as readonly string[]).includes(toolName)) {
    return { status: "abstain", reason: "not-a-source-tool", candidates: [], canonicalTimeout: false };
  }
  if (!isRecord(input)) return { status: "abstain", reason: "not-an-object", candidates: [], canonicalTimeout: false };

  let canonicalTimeout = false;
  const stringEntries: [string, string][] = [];

  for (const [key, raw] of Object.entries(input)) {
    if (SUPPORTING_KEYS.has(key)) {
      if (key === "timeout") {
        if (!isCanonicalTimeout(raw)) return { status: "abstain", reason: "invalid-timeout", candidates: [], canonicalTimeout: false };
        canonicalTimeout = true;
        continue;
      }
    }
    if (isRecord(raw) || Array.isArray(raw)) return { status: "abstain", reason: "unexplained-field", candidates: [], canonicalTimeout };
    if (typeof raw !== "string") return { status: "abstain", reason: "unexplained-field", candidates: [], canonicalTimeout };
    if (!SAFE_KEY.test(key)) return { status: "abstain", reason: "unsafe-key", candidates: [], canonicalTimeout };
    if (raw.trim().length === 0) continue; // empty string carries nothing
    if (raw.length > MAX_VALUE_CHARS) return { status: "abstain", reason: "oversized-value", candidates: [], canonicalTimeout };
    stringEntries.push([key, raw]);
  }

  if (stringEntries.length === 0) return { status: "abstain", reason: "no-candidates", candidates: [], canonicalTimeout };
  if (stringEntries.length > MAX_CANDIDATES) return { status: "abstain", reason: "too-many-candidates", candidates: [], canonicalTimeout };

  const candidates = stringEntries
    // Code-unit order, not locale order: ordinals must be stable everywhere.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value], index) => ({ ordinal: index + 1, key, value, ...featuresOf(value) }));

  return { status: "candidates", candidates, canonicalTimeout };
}

/** Candidate ordinals plus `none`, the closed choice set for the judge. */
export function mappingOptions(count: number): string[] {
  return [...Array.from({ length: count }, (_, index) => `candidate-${index + 1}`), "none"];
}
