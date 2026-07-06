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

export { repairArgs } from "./engine.ts";
export {
  coerceToBoolean,
  coerceToNumber,
  isNullLikeString,
  tryParseJsonString,
  trySplitStringToArray,
  unwrapMarkdownLink,
} from "./helpers.ts";
export { applyRelationalDefaults, objectRepairRules } from "./object-rules.ts";
export { repairRules } from "./rules.ts";
export type {
  ObjectRepairContext,
  ObjectRepairRule,
  ObjectRuleResult,
  Repair,
  RepairAction,
  RepairContext,
  RepairOptions,
  RepairResult,
  RepairRule,
  RepairValidation,
  RuleResult,
} from "./types.ts";
