import { objectRepairRules, repairRules } from "./repairs/index.ts";
import { resultRepairRules } from "./result-repairs/index.ts";

/**
 * Canonical toggle names for granular repair control. Derived from the rule
 * registries so new rules appear automatically.
 *
 * Note: "array-shape" is one registry rule emitting split-string/wrap-array/
 * wrap-object-array — it toggles as a group.
 */
export const REPAIR_NAMES: readonly string[] = Object.freeze([
  "strip-null",
  "strip-null-like",
  ...repairRules.map((rule) => rule.action),
  ...objectRepairRules.map((rule) => rule.action),
  ...resultRepairRules.map((rule) => rule.name),
  "resolve-ambiguous-edit",
  "restore-read-shape",
  "restore-read-path",
]);

export function isKnownRepairName(name: string): boolean {
  return REPAIR_NAMES.includes(name);
}
