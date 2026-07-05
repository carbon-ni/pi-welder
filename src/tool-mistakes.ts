/**
 * Model tool-call mistake telemetry.
 *
 * This is not a logger-first module. It captures structured signals about where
 * models make tool-call mistakes so future repair rules can target hotspots.
 */

export type MistakeKind = "syntax" | "schema" | "harness";
export type MistakePhase = "tool_call" | "tool_result";
export type MistakePattern =
  | "aliased_field"
  | "null_optional"
  | "empty_object_placeholder"
  | "stringified_array"
  | "bare_string_array"
  | "bare_string_root"
  | "tool_result_error";

export interface MistakeDraft {
  kind: MistakeKind;
  phase: MistakePhase;
  pattern: MistakePattern;
  toolName: string;
  input?: unknown;
  field?: string;
  receivedField?: string;
  errorContent?: string;
  repaired?: boolean;
  repairRules?: string[];
}

export interface ToolMistake extends MistakeDraft {
  id: number;
  timestamp: string;
  toolCallId: string;
  cwd: string;
  modelId?: string;
}

export interface ToolMistakeTelemetry {
  nextId: number;
  records: ToolMistake[];
}

export interface ToolCallInput {
  toolName: string;
  input: unknown;
}

export interface ToolResultInput {
  toolName: string;
  isError: boolean;
  details?: { exitCode?: number } | unknown;
  content: Array<{ type: string; text?: string }>;
}

export interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  aliases?: string[];
}

export type ToolSchema = Record<string, SchemaField>;

export const BUILTIN_SCHEMAS: Record<string, ToolSchema> = {
  read: {
    path: { type: "string", required: true, aliases: ["absolutePath", "file_path", "filePath", "filepath", "pathname", "target_file", "targetFile", "file", "absolute_path", "fileAbsolutePath"] },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  write: {
    path: { type: "string", required: true, aliases: ["absolutePath", "file_path", "filePath", "filepath", "pathname", "target_file", "targetFile"] },
    content: { type: "string", required: true, aliases: ["text", "body", "data", "contents", "fileContent"] },
  },
  edit: {
    path: { type: "string", required: true, aliases: ["absolutePath", "file_path", "filePath", "filepath", "pathname", "target_file", "targetFile"] },
    oldText: { type: "string", required: true, aliases: ["old_string", "oldString", "old", "old_str", "oldStr", "from", "old_value", "old_text", "oldContent", "old_content"] },
    newText: { type: "string", required: true, aliases: ["new_string", "newString", "new", "new_str", "newStr", "to", "new_value", "new_text", "newContent", "new_content"] },
    replaceAll: { type: "boolean" },
  },
  bash: {
    command: { type: "string", required: true, aliases: ["cmd", "shell", "script", "commandLine"] },
    timeout: { type: "number" },
  },
  grep: {
    pattern: { type: "string", required: true, aliases: ["query", "regex", "search", "q", "expression", "text"] },
    include: { type: "array" },
  },
  find: {
    pattern: { type: "string", required: true, aliases: ["query", "glob", "expression", "search", "include"] },
  },
  ls: {
    path: { type: "string", aliases: ["absolutePath", "directory", "dir", "folder", "directoryPath"] },
  },
};

export const STRING_ROOT_FIELD: Record<string, string> = {
  bash: "command",
  find: "pattern",
  grep: "pattern",
  ls: "path",
  read: "path",
};

export function collectToolCallMistakes(event: ToolCallInput): MistakeDraft[] {
  const schema = BUILTIN_SCHEMAS[event.toolName];
  if (!schema) return [];

  if (typeof event.input === "string") {
    const field = STRING_ROOT_FIELD[event.toolName];
    if (!field) return [];
    return [{
      kind: "syntax",
      phase: "tool_call",
      pattern: "bare_string_root",
      toolName: event.toolName,
      field,
      input: event.input,
    }];
  }

  if (!isRecord(event.input)) return [];

  const mistakes: MistakeDraft[] = [];
  for (const [field, fieldSchema] of Object.entries(schema)) {
    const alias = fieldSchema.aliases?.find((name) => name in event.input as Record<string, unknown>);
    if (alias && !(field in event.input)) {
      mistakes.push({
        kind: "schema",
        phase: "tool_call",
        pattern: "aliased_field",
        toolName: event.toolName,
        field,
        receivedField: alias,
        input: event.input,
      });
    }

    const value = event.input[field];
    if (value === null && !fieldSchema.required) {
      mistakes.push({ kind: "schema", phase: "tool_call", pattern: "null_optional", toolName: event.toolName, field, input: event.input });
      continue;
    }

    if (fieldSchema.type === "array" && isEmptyObject(value)) {
      mistakes.push({ kind: "schema", phase: "tool_call", pattern: "empty_object_placeholder", toolName: event.toolName, field, input: event.input });
      continue;
    }

    if (fieldSchema.type === "array" && typeof value === "string") {
      mistakes.push({
        kind: "schema",
        phase: "tool_call",
        pattern: isJsonArrayString(value) ? "stringified_array" : "bare_string_array",
        toolName: event.toolName,
        field,
        input: event.input,
      });
    }
  }
  return mistakes;
}

export function collectToolResultMistake(event: ToolResultInput): MistakeDraft | null {
  if (!event.isError) return null;
  if (event.toolName === "bash") {
    const exitCode = (event.details as { exitCode?: number } | undefined)?.exitCode;
    if (exitCode !== undefined) return null;
  }

  return {
    kind: "harness",
    phase: "tool_result",
    pattern: "tool_result_error",
    toolName: event.toolName,
    errorContent: joinText(event.content),
  };
}

export function emptyTelemetry(): ToolMistakeTelemetry {
  return { nextId: 1, records: [] };
}

export function recordMistake(
  telemetry: ToolMistakeTelemetry,
  draft: MistakeDraft & { toolCallId: string; cwd: string; modelId?: string },
  now: () => string = () => new Date().toISOString(),
): ToolMistakeTelemetry {
  const record: ToolMistake = {
    id: telemetry.nextId,
    timestamp: now(),
    ...draft,
  };
  return { nextId: telemetry.nextId + 1, records: [...telemetry.records, record] };
}

export function summarizeTelemetry(telemetry: ToolMistakeTelemetry): string {
  if (telemetry.records.length === 0) return "No model tool-call mistakes recorded.";
  const counts = new Map<string, { total: number; repaired: number }>();
  for (const record of telemetry.records) {
    const key = `${record.modelId ?? "unknown-model"} ${record.toolName} ${record.pattern}`;
    const current = counts.get(key) ?? { total: 0, repaired: 0 };
    counts.set(key, {
      total: current.total + 1,
      repaired: current.repaired + (record.repaired ? 1 : 0),
    });
  }
  const lines = [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}: ${count.total}${count.repaired > 0 ? ` (repaired ${count.repaired})` : ""}`);
  return [`${telemetry.records.length} model tool-call mistakes:`, ...lines].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isJsonArrayString(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function joinText(content: ToolResultInput["content"]): string {
  return content.map((part) => part.type === "text" && part.text ? part.text : "").filter(Boolean).join(" ");
}
