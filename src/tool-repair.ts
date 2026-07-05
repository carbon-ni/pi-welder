import { BUILTIN_SCHEMAS, STRING_ROOT_FIELD, type ToolSchema } from "./tool-mistakes.ts";

export type RepairRule =
  | "wrapRootStringAsObject"
  | "renameAliasedField"
  | "dropNullOptional"
  | "dropEmptyObjectPlaceholder"
  | "parseJsonStringifiedArray"
  | "wrapBareStringAsArray";

export interface ToolCallRepairInput {
  toolName: string;
  input: unknown;
}

export interface ToolCallRepairResult {
  changed: boolean;
  input: unknown;
  rulesFired: RepairRule[];
}

export function repairToolCallInput(event: ToolCallRepairInput): ToolCallRepairResult {
  const schema = BUILTIN_SCHEMAS[event.toolName];
  if (!schema) return unchanged(event.input);

  if (typeof event.input === "string") {
    const field = STRING_ROOT_FIELD[event.toolName];
    if (!field) return unchanged(event.input);
    return {
      changed: true,
      input: { [field]: event.input },
      rulesFired: ["wrapRootStringAsObject"],
    };
  }

  if (!isRecord(event.input)) return unchanged(event.input);

  const repaired = { ...event.input };
  const rulesFired: RepairRule[] = [];

  renameAliasedFields(repaired, schema, rulesFired);
  dropNullOptionalFields(repaired, schema, rulesFired);
  dropEmptyObjectPlaceholders(repaired, schema, rulesFired);
  parseJsonStringifiedArrays(repaired, schema, rulesFired);
  wrapBareStringArrays(repaired, schema, rulesFired);

  if (rulesFired.length === 0) return unchanged(event.input);
  if (!isValidInput(repaired, schema)) return unchanged(event.input);
  return { changed: true, input: repaired, rulesFired };
}

function renameAliasedFields(
  input: Record<string, unknown>,
  schema: ToolSchema,
  rulesFired: RepairRule[],
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (field in input) continue;

    const alias = fieldSchema.aliases?.find((name) => name in input);
    if (!alias) continue;

    input[field] = input[alias];
    delete input[alias];
    addRule(rulesFired, "renameAliasedField");
  }
}

function dropNullOptionalFields(
  input: Record<string, unknown>,
  schema: ToolSchema,
  rulesFired: RepairRule[],
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.required) continue;
    if (input[field] !== null) continue;

    delete input[field];
    addRule(rulesFired, "dropNullOptional");
  }
}

function dropEmptyObjectPlaceholders(
  input: Record<string, unknown>,
  schema: ToolSchema,
  rulesFired: RepairRule[],
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.type !== "array") continue;
    if (!isEmptyObject(input[field])) continue;

    delete input[field];
    addRule(rulesFired, "dropEmptyObjectPlaceholder");
  }
}

function parseJsonStringifiedArrays(
  input: Record<string, unknown>,
  schema: ToolSchema,
  rulesFired: RepairRule[],
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.type !== "array") continue;
    if (typeof input[field] !== "string") continue;

    const parsed = parseJsonArray(input[field]);
    if (!parsed.ok) continue;

    input[field] = parsed.value;
    addRule(rulesFired, "parseJsonStringifiedArray");
  }
}

function wrapBareStringArrays(
  input: Record<string, unknown>,
  schema: ToolSchema,
  rulesFired: RepairRule[],
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.type !== "array") continue;
    if (typeof input[field] !== "string") continue;

    input[field] = [input[field]];
    addRule(rulesFired, "wrapBareStringAsArray");
  }
}

function parseJsonArray(value: string): { ok: true; value: unknown[] } | { ok: false } {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

function addRule(rulesFired: RepairRule[], rule: RepairRule) {
  if (!rulesFired.includes(rule)) rulesFired.push(rule);
}

function unchanged(input: unknown): ToolCallRepairResult {
  return { changed: false, input, rulesFired: [] };
}

function isValidInput(input: Record<string, unknown>, schema: ToolSchema): boolean {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = input[field];
    if (fieldSchema.required && value === undefined) return false;
    if (value === undefined) continue;
    if (!matchesType(value, fieldSchema.type)) return false;
  }
  return true;
}

function matchesType(value: unknown, type: ToolSchema[string]["type"]): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}
