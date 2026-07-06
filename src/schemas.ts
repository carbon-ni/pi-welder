export interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
}

export type ToolSchema = Record<string, SchemaField>;

export interface ValidationIssue {
  code: "missing-field" | "invalid-type";
  path: string[];
  expected?: string;
  received?: string;
}

const defineSchema = (schema: ToolSchema): ToolSchema => schema;

export const TOOL_SCHEMAS: ReadonlyMap<string, ToolSchema> = new Map<string, ToolSchema>([
  ["read", defineSchema({
    path: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  })],
  ["write", defineSchema({
    path: { type: "string" },
    content: { type: "string" },
  })],
  ["edit", defineSchema({
    path: { type: "string" },
    edits: { type: "array" },
  })],
  ["bash", defineSchema({
    command: { type: "string" },
    timeout: { type: "number" },
  })],
]);

export const FIELD_ALIASES: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  ["read", new Map([
    ["path", ["absolutePath", "absolute_path", "file_path", "filePath", "filepath", "file"]],
  ])],
  ["write", new Map([
    ["path", ["absolutePath", "absolute_path", "file_path", "filePath", "filepath", "file"]],
    ["content", ["text", "body", "data", "contents", "fileContent"]],
  ])],
  ["edit", new Map([
    ["path", ["absolutePath", "absolute_path", "file_path", "filePath", "filepath", "file"]],
    ["edits", ["replacements"]],
  ])],
  ["bash", new Map([
    ["command", ["cmd", "shell", "script", "commandLine"]],
  ])],
]);

export function schemaForTool(toolName: string | undefined): ToolSchema | undefined {
  return toolName ? TOOL_SCHEMAS.get(toolName) : undefined;
}

export function hasUnknownSchemaField(input: Record<string, unknown>, schema: ToolSchema): boolean {
  return Object.keys(input).some((key) => !(key in schema));
}

export function hasSchemaRepairSignal(toolName: string | undefined, input: Record<string, unknown>): boolean {
  if (!toolName) return false;
  if (toolName === "edit" && !("edits" in input) && ("oldText" in input || "old_text" in input)) return true;

  const aliases = FIELD_ALIASES.get(toolName);
  if (!aliases) return false;

  for (const [canonical, aliasList] of aliases.entries()) {
    if (canonical in input) continue;
    if (aliasList.some((alias) => alias in input && input[alias] != null)) return true;
  }
  return false;
}

export function validateAgainstSchema(input: Record<string, unknown>, schema: ToolSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [fieldName, field] of Object.entries(schema)) {
    const value = input[fieldName];
    if (value === undefined) continue;
    if (value === null) {
      if (field.required) issues.push({ code: "missing-field", path: [fieldName], expected: field.type, received: "null" });
      if (!field.required) issues.push({ code: "invalid-type", path: [fieldName], expected: field.type, received: "null" });
      continue;
    }

    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== field.type) {
      issues.push({ code: "invalid-type", path: [fieldName], expected: field.type, received: actual });
    }
  }

  return issues;
}
