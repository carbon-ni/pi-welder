/**
 * TASK-0038 — eligibility for Jev-judged bash routing.
 *
 * A non-exact call is eligible only when it carries exactly one bounded
 * non-empty string under a safe key, plus at most a valid canonical timeout.
 * Extra fields are never silently dropped; they make the call ineligible.
 */

export const MAX_JUDGED_FIELDS = 2;
export const MAX_CANDIDATE_CHARS = 512;
export const CANONICAL_TIMEOUT_MAX_SECONDS = 2_147_483.647;

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;

export interface JudgedCandidate {
  key: string;
  candidate: string;
  timeout?: number;
}

export type IneligibilityReason =
  | "not-an-object"
  | "empty"
  | "multiple-fields"
  | "unsafe-key"
  | "not-a-string"
  | "empty-string"
  | "oversized"
  | "invalid-timeout";

export interface JudgmentEligibility {
  eligible: boolean;
  reason?: IneligibilityReason;
  candidate?: JudgedCandidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= CANONICAL_TIMEOUT_MAX_SECONDS;
}

/**
 * Evaluates the ORIGINAL arguments of a read/write/edit call that the exact
 * router did not accept. Callers must check the exact `{command, timeout}`
 * shape first so TASK-0034 stays deterministic and Jev-free.
 */
export function judgeEligibility(input: unknown): JudgmentEligibility {
  if (!isRecord(input)) return { eligible: false, reason: "not-an-object" };
  const keys = Object.keys(input);
  if (keys.length === 0) return { eligible: false, reason: "empty" };
  if (keys.length > MAX_JUDGED_FIELDS) return { eligible: false, reason: "multiple-fields" };

  let candidateKey: string | undefined;
  let candidateValue: string | undefined;
  let timeout: number | undefined;

  for (const key of keys) {
    const value = input[key];
    if (key === "timeout") {
      if (!isCanonicalTimeout(value)) return { eligible: false, reason: "invalid-timeout" };
      timeout = value;
      continue;
    }
    if (!SAFE_KEY.test(key)) return { eligible: false, reason: "unsafe-key" };
    if (typeof value !== "string") return { eligible: false, reason: "not-a-string" };
    if (value.trim().length === 0) return { eligible: false, reason: "empty-string" };
    if (value.length > MAX_CANDIDATE_CHARS) return { eligible: false, reason: "oversized" };
    if (candidateKey !== undefined) return { eligible: false, reason: "multiple-fields" };
    candidateKey = key;
    candidateValue = value;
  }

  if (candidateKey === undefined || candidateValue === undefined) return { eligible: false, reason: "empty" };
  return { eligible: true, candidate: { key: candidateKey, candidate: candidateValue, ...(timeout === undefined ? {} : { timeout }) } };
}
