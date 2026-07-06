import { CONTENT_FIELDS } from "../fields.ts";
import { hasSchemaRepairSignal, hasUnknownSchemaField, schemaForTool, validateAgainstSchema } from "../schemas.ts";
import { isNullLikeString } from "./helpers.ts";
import { objectRepairRules } from "./object-rules.ts";
import { repairRules } from "./rules.ts";
import type {
  ObjectRuleResult,
  Repair,
  RepairOptions,
  RepairResult,
  RepairValidation,
  ResolvedRepairOptions,
  RepairContext,
} from "./types.ts";

/** Repair every field of a tool-call args object. Pure. */
export function repairArgs(input: Record<string, unknown>, options: RepairOptions = {}): RepairResult {
  const resolvedOptions = resolveRepairOptions(options);
  const schema = schemaForTool(resolvedOptions.toolName);

  const preValidationIssues = schema ? validateAgainstSchema(input, schema) : [];
  const validation = schema ? validationResult(preValidationIssues.length === 0, false) : undefined;

  if (
    schema &&
    preValidationIssues.length === 0 &&
    !hasSchemaRepairSignal(resolvedOptions.toolName, input) &&
    !hasUnknownSchemaField(input, schema)
  ) {
    return { result: input, repairs: [], validation };
  }

  let [result, repairs] = repairObjectFields(input, "input", resolvedOptions);

  const objectResult = repairTopLevelObject(result, resolvedOptions);
  result = objectResult.result;
  repairs = [...repairs, ...objectResult.repairs];

  if (schema && validateAgainstSchema(result, schema).length > 0) {
    return { result: input, repairs: [], validation: validationResult(false, true) };
  }

  return { result, repairs, validation };
}

function resolveRepairOptions(options: RepairOptions): ResolvedRepairOptions {
  return {
    toolName: options.toolName,
    rules: options.rules ?? [...repairRules, ...(options.extraRules ?? [])],
    objectRules: options.objectRules ?? [...(options.extraObjectRules ?? []), ...objectRepairRules],
  };
}

function validationResult(passed: boolean, rejected: boolean): RepairValidation {
  return { checked: true, passed, rejected };
}

function repairTopLevelObject(input: Record<string, unknown>, options: ResolvedRepairOptions): ObjectRuleResult {
  let result = input;
  const repairs: Repair[] = [];

  for (const rule of options.objectRules) {
    const ruleResult = rule.repair(result, { parentPath: "input", toolName: options.toolName });
    result = ruleResult.result;
    repairs.push(...ruleResult.repairs);
  }

  return { result, repairs };
}

function repairObjectFields(
  obj: Record<string, unknown>,
  parentPath: string,
  options: ResolvedRepairOptions,
): [Record<string, unknown>, Repair[]] {
  const result: Record<string, unknown> = {};
  const repairs: Repair[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = `${parentPath}.${key}`;

    // Content fields: never transformed; null → "" to avoid downstream crashes.
    if (CONTENT_FIELDS.has(key)) {
      result[key] = value == null ? "" : value;
      continue;
    }

    // strip-null — omit null optional fields entirely.
    if (value === null) {
      repairs.push({ field: fieldPath, action: "strip-null" });
      continue;
    }

    // strip-null-like — omit "null"/"none"/"n/a" string spellings.
    if (isNullLikeString(value)) {
      repairs.push({ field: fieldPath, action: "strip-null-like" });
      continue;
    }

    const [repaired, fieldRepairs] = repairValue(value, key, fieldPath, options);
    result[key] = repaired;
    repairs.push(...fieldRepairs);
  }

  return [result, repairs];
}

/**
 * Apply ordered structural repairs to a single field value.
 * Registry order is the extension point: parse-json → array-shape matters.
 */
function repairValue(value: unknown, key: string, fieldPath: string, options: ResolvedRepairOptions): [unknown, Repair[]] {
  const repairs: Repair[] = [];
  const ctx: RepairContext = { key, fieldPath, parsedFromString: false, toolName: options.toolName };

  for (const rule of options.rules) {
    const result = rule.repair(value, ctx);
    value = result.value;
    repairs.push(...result.repairs);
    ctx.parsedFromString = ctx.parsedFromString || result.parsedFromString === true;
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const [repaired, itemRepairs] = repairValue(value[i], "[item]", `${fieldPath}[${i}]`, options);
      items.push(repaired);
      repairs.push(...itemRepairs);
    }
    value = items;
  } else if (typeof value === "object" && value !== null) {
    const [repairedObj, nested] = repairObject(value as Record<string, unknown>, fieldPath, options);
    value = repairedObj;
    repairs.push(...nested);
  }

  return [value, repairs];
}

/** Internal: repair a nested object in place (recursion target). */
function repairObject(
  obj: Record<string, unknown>,
  parentPath: string,
  options: ResolvedRepairOptions,
): [Record<string, unknown>, Repair[]] {
  return repairObjectFields(obj, parentPath, options);
}
