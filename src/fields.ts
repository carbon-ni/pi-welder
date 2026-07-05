/**
 * Field taxonomy — the single source of truth for how fields are classified.
 *
 * Repair decisions are field-name based: a finite set of recurring LLM
 * tool-calling mistakes map to a finite set of structural repairs. Naming
 * a field here is the only place that needs to change to grow coverage.
 */

/** Fields that hold a filesystem path. Gets markdown-link unwrapping. */
export const PATH_FIELDS: ReadonlySet<string> = new Set([
  "path",
  "absolutePath",
  "filePath",
  "directory",
  "cwd",
  "target",
  "dir",
  "modulePath",
]);

/** Fields that should be arrays. Bare values get wrapped, strings get split. */
export const ARRAY_FIELDS: ReadonlySet<string> = new Set([
  "edits",
  "files",
  "replacements",
  "paths",
  "function_names",
  "functionNames",
  "symbols",
  "queries",
  "urls",
  "commands",
  "steps",
  "args",
  "values",
  "items",
  "extensions",
  "include",
  "exclude",
  "options",
  "headers",
  "tasks",
  "patterns",
  "names",
  "ids",
  "schemas",
  "messages",
  "prompts",
  "parameters",
  "responses",
  "tools",
  "skills",
  "tags",
  "categories",
  "roles",
  "permissions",
]);

/** Fields that should be booleans. String "true"/"yes" etc. get coerced. */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  "strict",
  "force",
  "dry_run",
  "dryRun",
  "verbose",
  "quiet",
  "silent",
  "debug",
  "enabled",
  "disabled",
  "optional",
  "required",
  "recursive",
  "followSymlinks",
  "follow_symlinks",
  "includeHidden",
  "include_hidden",
]);

/** Fields that should be numbers. Numeric strings get coerced. */
export const NUMBER_FIELDS: ReadonlySet<string> = new Set([
  "offset",
  "limit",
  "timeout",
  "timeout_seconds",
  "concurrency",
  "maxTokens",
  "max_tokens",
  "maxResults",
  "max_results",
  "numResults",
  "num_results",
  "start_line",
  "end_line",
  "port",
  "ttl",
  "context",
  "maxDepth",
  "maxFiles",
  "retries",
  "interval",
  "count",
  "size",
  "index",
]);

/**
 * Content fields — NEVER repaired. These carry user/authored payload where
 * any transformation (null-strip, coercion, splitting) would corrupt intent.
 * A null content field is normalized to "" so downstream tools fail with a
 * clear validation error instead of a cryptic TypeError on undefined.
 */
export const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "content",
  "text",
  "command",
  "oldText",
  "old_text",
  "newText",
  "new_text",
  "code",
  "source",
  "data",
  "body",
  "message",
  "description",
  "instructions",
  "prompt",
  "summary",
  "comment",
  "note",
]);

/**
 * Allowed properties for array items, keyed by parent field name.
 * LLMs commonly duplicate parent-level params (e.g. `path`) into each item,
 * tripping schema validation. We strip anything not in the allowed set.
 */
export const ARRAY_ITEM_SCHEMAS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["edits", new Set(["oldText", "newText"])],
  ["replacements", new Set(["path", "symbol", "text"])],
  ["files", new Set(["path", "edits", "replacements"])],
  ["tasks", new Set(["agent", "task", "count", "output", "outputMode", "reads", "progress", "model", "skill", "cwd"])],
  ["steps", new Set(["agent", "task", "output", "outputMode", "reads", "progress", "model", "skill", "cwd"])],
  ["commands", new Set(["label", "command"])],
]);

/** Strings LLMs emit when they mean "omit this field". */
export const NULL_LIKE_STRINGS: ReadonlySet<string> = new Set([
  "",
  "null",
  "none",
  "n/a",
  "na",
  "undefined",
]);

/** Truthy/falsy string spellings for boolean coercion. */
export const TRUTHY_STRINGS: ReadonlySet<string> = new Set([
  "true", "yes", "on", "y", "t", "enabled", "1",
]);
export const FALSY_STRINGS: ReadonlySet<string> = new Set([
  "false", "no", "off", "n", "f", "disabled", "0",
]);

/** A field name looks like a path/URL/flag token rather than a file path. */
export function isUrlOrFlag(token: string): boolean {
  return token.startsWith("http") || token.startsWith("-");
}
