import type { ObjectRepairRule, Repair, RepairResult } from "./types.ts";

const relationalDefaultRule: ObjectRepairRule = {
  action: "relational-default",
  repair(input, ctx) {
    const result = { ...input };
    const repairs: Repair[] = [];
    if ("limit" in result && !("offset" in result)) {
      result.offset = 1;
      repairs.push({ field: `${ctx.parentPath}.offset`, action: "relational-default" });
    }
    if ("offset" in result && !("limit" in result)) {
      result.limit = 2000;
      repairs.push({ field: `${ctx.parentPath}.limit`, action: "relational-default" });
    }
    return { result, repairs };
  },
};

export const objectRepairRules: readonly ObjectRepairRule[] = Object.freeze([
  relationalDefaultRule,
]);

/**
 * Pairs of co-dependent numeric fields: if one is present, the missing one
 * gets a sensible default. Stops the model re-reading the same first page.
 */
export function applyRelationalDefaults(input: Record<string, unknown>): RepairResult {
  return relationalDefaultRule.repair(input, { parentPath: "input" });
}
