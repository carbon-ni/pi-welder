import { FIELD_ALIASES } from "../schemas.ts";
import type { ObjectRepairRule, Repair, RepairResult } from "./types.ts";

/** Flat edit-field spellings the model emits at top level instead of in `edits`. */
const OLD_TEXT_KEYS = ["oldText", "old_text"] as const;
const NEW_TEXT_KEYS = ["newText", "new_text"] as const;

const renameAliasedFieldRule: ObjectRepairRule = {
  action: "rename-aliased-field",
  repair(input, ctx) {
    if (!ctx.toolName) return { result: input, repairs: [] };
    const aliases = FIELD_ALIASES.get(ctx.toolName);
    if (!aliases) return { result: input, repairs: [] };

    const result = { ...input };
    const repairs: Repair[] = [];
    for (const [canonical, aliasList] of aliases.entries()) {
      if (canonical in result) continue;
      const alias = aliasList.find((candidate) => candidate in result && result[candidate] != null);
      if (!alias) continue;
      result[canonical] = result[alias];
      delete result[alias];
      repairs.push({ field: `${ctx.parentPath}.${canonical}`, action: "rename-aliased-field" });
    }

    return repairs.length > 0 ? { result, repairs } : { result: input, repairs: [] };
  },
};

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

interface AnchoredInsertion {
  oldText: string;
  newText: string;
}

function anchoredInsertionAt(edits: unknown[], index: number): AnchoredInsertion | undefined {
  const anchorEdit = edits[index];
  const insertionEdit = edits[index + 1];
  if (!isRecord(anchorEdit) || !isRecord(insertionEdit)) return undefined;
  if (!hasOnlyKeys(anchorEdit, "oldText", "newText") || !hasOnlyKeys(insertionEdit, "newText")) return undefined;

  const oldText = anchorEdit.oldText;
  const anchorNewText = anchorEdit.newText;
  const insertionNewText = insertionEdit.newText;
  if (typeof oldText !== "string" || oldText.length === 0) return undefined;
  if (anchorNewText !== oldText || typeof insertionNewText !== "string") return undefined;
  if (!insertionNewText.endsWith(oldText)) return undefined;

  return { oldText, newText: insertionNewText };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, ...expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

export function hasMergeEditAnchorSignal(input: Record<string, unknown>): boolean {
  const edits = input.edits;
  if (!Array.isArray(edits)) return false;
  return edits.some((_, index) => anchoredInsertionAt(edits, index) !== undefined);
}

const mergeEditAnchorRule: ObjectRepairRule = {
  action: "merge-edit-anchor",
  repair(input, ctx) {
    if (ctx.toolName !== "edit" || !hasMergeEditAnchorSignal(input)) return { result: input, repairs: [] };

    const edits = input.edits as unknown[];
    const mergedEdits: unknown[] = [];
    const repairs: Repair[] = [];
    for (let index = 0; index < edits.length; index++) {
      const insertion = anchoredInsertionAt(edits, index);
      if (!insertion) {
        mergedEdits.push(edits[index]);
        continue;
      }
      mergedEdits.push(insertion);
      repairs.push({ field: `${ctx.parentPath}.edits[${index}]`, action: "merge-edit-anchor" });
      index++;
    }

    return { result: { ...input, edits: mergedEdits }, repairs };
  },
};

export const objectRepairRules: readonly ObjectRepairRule[] = Object.freeze([
  renameAliasedFieldRule,
  relationalDefaultRule,
  nestEditFieldsRule,
  mergeEditAnchorRule,
]);

/**
 * Pairs of co-dependent numeric fields: if one is present, the missing one
 * gets a sensible default. Stops the model re-reading the same first page.
 */
export function applyRelationalDefaults(input: Record<string, unknown>): RepairResult {
  return relationalDefaultRule.repair(input, { parentPath: "input" });
}
