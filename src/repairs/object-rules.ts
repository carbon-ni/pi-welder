import type { ObjectRepairRule, Repair, RepairResult } from "./types.ts";

/** Flat edit-field spellings the model emits at top level instead of in `edits`. */
const OLD_TEXT_KEYS = ["oldText", "old_text"] as const;
const NEW_TEXT_KEYS = ["newText", "new_text"] as const;

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

/**
 * When the edit tool receives flat `oldText`/`newText` at top level (no
 * `edits` array), nest them into `edits: [{...}]`. Content stays verbatim.
 */
const nestEditFieldsRule: ObjectRepairRule = {
  action: "nest-edit-fields",
  repair(input, ctx) {
    if (ctx.toolName !== "edit") return { result: input, repairs: [] };
    if ("edits" in input) return { result: input, repairs: [] };

    const oldKey = OLD_TEXT_KEYS.find((k) => k in input);
    if (!oldKey) return { result: input, repairs: [] };

    const newKey = NEW_TEXT_KEYS.find((k) => k in input);
    const edit: Record<string, unknown> = { [oldKey]: input[oldKey] };
    if (newKey) edit[newKey] = input[newKey];

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (k === oldKey || k === newKey) continue;
      result[k] = v;
    }
    result.edits = [edit];
    return {
      result,
      repairs: [{ field: `${ctx.parentPath}.edits`, action: "nest-edit-fields" }],
    };
  },
};

export const objectRepairRules: readonly ObjectRepairRule[] = Object.freeze([
  relationalDefaultRule,
  nestEditFieldsRule,
]);

/**
 * Pairs of co-dependent numeric fields: if one is present, the missing one
 * gets a sensible default. Stops the model re-reading the same first page.
 */
export function applyRelationalDefaults(input: Record<string, unknown>): RepairResult {
  return relationalDefaultRule.repair(input, { parentPath: "input" });
}
