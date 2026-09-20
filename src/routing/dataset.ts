/**
 * TASK-0021 — frozen labeled routing dataset.
 *
 * Real failure shapes observed in the welder-log corpus (2026-09-19), rewritten
 * with synthetic relative paths. Labels are an existing repair rule ID or
 * "none" (no rule should fire). Every case is sanitized at use time; the
 * committed text contains no real paths, source, commands, or credentials.
 *
 * Labels are authored from the failure shape, never from model output.
 */

import type { RepairAction } from "../repairs/types.ts";

export type RoutingLabel = RepairAction | "none";

export interface LabeledFailure {
  caseId: string;
  toolName: string;
  errorKind: string;
  /** Synthetic paths only; sanitized before any transmission. */
  errorText: string;
  label: RoutingLabel;
}

export const LABELED_FAILURES: readonly LabeledFailure[] = [
  // edit: text not found / ambiguous -> resolve-ambiguous-edit
  { caseId: "edit-not-found-1", toolName: "edit", errorKind: "EDIT_NOT_FOUND", errorText: "Could not find edits[0] in src/app/config.ts. The oldText must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-found-2", toolName: "edit", errorKind: "TOOL_ERROR", errorText: "Could not find the exact text in src/app/config.ts. The old text must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-found-3", toolName: "edit", errorKind: "EDIT_MISMATCH", errorText: "Could not find edits[1] in src/lib/util.ts. The oldText must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-found-4", toolName: "edit", errorKind: "TOOL_ERROR", errorText: "Could not find the exact text in src/other/thing.sh. The old text must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-found-5", toolName: "edit", errorKind: "EDIT_NOT_FOUND", errorText: "Could not find edits[0] in src/round-clip/hook.scad. The oldText must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-found-6", toolName: "edit", errorKind: "EDIT_MISMATCH", errorText: "Could not find edits[2] in src/tools/runner.rs. The oldText must match exactly including all whitespace and newlines.", label: "resolve-ambiguous-edit" },

  // edit: multiple exact occurrences -> resolve-ambiguous-edit
  { caseId: "edit-not-unique-1", toolName: "edit", errorKind: "EDIT_NOT_UNIQUE", errorText: "Found 2 occurrences of edits[1] in src/app/config.ts. Each oldText must be unique. Please provide more context to make it unique.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-unique-2", toolName: "edit", errorKind: "EDIT_NOT_UNIQUE", errorText: "Found 3 occurrences of the text in src/app/config.ts. The text must be unique. Please provide more context to make it unique.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-unique-3", toolName: "edit", errorKind: "TOOL_ERROR", errorText: "Found 2 occurrences of the text in src/app/config.ts. The text must be unique. Please provide more context to make it unique.", label: "resolve-ambiguous-edit" },
  { caseId: "edit-not-unique-4", toolName: "edit", errorKind: "TOOL_ERROR", errorText: "Found 5 occurrences of the exact text in src/lib/util.ts. The text must be unique.", label: "resolve-ambiguous-edit" },

  // edit: verified no-op -> edit-noop
  { caseId: "edit-noop-1", toolName: "edit", errorKind: "SCHEMA", errorText: "No changes made to src/app/hook.scad. The replacement produced identical content. This might indicate an issue with special characters.", label: "edit-noop" },
  { caseId: "edit-noop-2", toolName: "edit", errorKind: "SCHEMA", errorText: "No changes made to src/app/config.ts. The replacement produced identical content.", label: "edit-noop" },
  { caseId: "edit-noop-3", toolName: "edit", errorKind: "TOOL_ERROR", errorText: "No changes made. The replacement produced identical content.", label: "edit-noop" },

  // read: missing path -> missing-read-context
  { caseId: "read-enoent-1", toolName: "read", errorKind: "ENOENT", errorText: "ENOENT: no such file or directory, access 'src/app/config.ts'", label: "missing-read-context" },
  { caseId: "read-enoent-2", toolName: "read", errorKind: "ENOENT", errorText: "ENOENT", label: "missing-read-context" },
  { caseId: "read-enoent-3", toolName: "read", errorKind: "ENOENT", errorText: "ENOENT: no such file or directory, access 'docs/notes.md' Requested path: docs/notes.md Tree from: docs .", label: "missing-read-context" },
  { caseId: "read-enoent-4", toolName: "read", errorKind: "ENOENT", errorText: "File not found: docs/notes/summary.md (ENOENT)", label: "missing-read-context" },
  { caseId: "read-enoent-5", toolName: "read", errorKind: "ENOENT", errorText: "ENOENT: no such file or directory, open 'src/missing/file.ts'", label: "missing-read-context" },

  // read: offset past EOF -> read-offset-context
  { caseId: "read-offset-1", toolName: "read", errorKind: "TOOL_ERROR", errorText: "Offset 900 is beyond end of file (42 lines total)", label: "read-offset-context" },
  { caseId: "read-offset-2", toolName: "read", errorKind: "TOOL_ERROR", errorText: "Offset 5 is beyond end of file (3 lines total)", label: "read-offset-context" },

  // read: directory -> directory-read
  { caseId: "read-eisdir-1", toolName: "read", errorKind: "EISDIR", errorText: "EISDIR: illegal operation on a directory, read", label: "directory-read" },
  { caseId: "read-eisdir-2", toolName: "read", errorKind: "TOOL_ERROR", errorText: "EISDIR: illegal operation on a directory, read 'src'", label: "directory-read" },

  // edit: overlap, missing file, invalid shape -> none
  { caseId: "edit-overlap-1", toolName: "edit", errorKind: "EDIT_OVERLAP", errorText: "edits[0] and edits[1] overlap in src/app/config.ts. Merge them into one edit or target disjoint regions.", label: "none" },
  { caseId: "edit-enoent-1", toolName: "edit", errorKind: "ENOENT", errorText: "Could not edit file: src/app/config.ts. Error code: ENOENT.", label: "none" },
  { caseId: "edit-schema-1", toolName: "edit", errorKind: "SCHEMA", errorText: "Missing required field: edits.", label: "none" },
  { caseId: "edit-schema-2", toolName: "edit", errorKind: "SCHEMA", errorText: "Invalid parameter type for edits; expected array.", label: "none" },

  // execution and watcher noise -> none
  { caseId: "bash-exit-1", toolName: "bash", errorKind: "TOOL_ERROR", errorText: "(no output) Command exited with code 1", label: "none" },
  { caseId: "bash-timeout-1", toolName: "bash", errorKind: "TOOL_ERROR", errorText: "Command timed out after 120 seconds", label: "none" },
  { caseId: "bash-format-1", toolName: "bash", errorKind: "TOOL_ERROR", errorText: "[warn] Code style issues found in the above file. Run Prettier with --write to fix.", label: "none" },
  { caseId: "bash-commit-1", toolName: "bash", errorKind: "TOOL_ERROR", errorText: "Commit subject must start with one of: feat, fix, docs, test, chore, refactor", label: "none" },
  { caseId: "bash-nx-1", toolName: "bash", errorKind: "NX", errorText: "NX Running target test for project webapp and 3 tasks it depends on", label: "none" },
  { caseId: "bash-jql-1", toolName: "bash", errorKind: "SCHEMA", errorText: "Error in the JQL Query: Expecting a string but got a value. (line 1, character 30)", label: "none" },
  { caseId: "watcher-enoent-1", toolName: "watcher_status", errorKind: "ENOENT", errorText: "Funzzy unavailable after 500ms: connect ENOENT .pi/funzzy.sock", label: "none" },
  { caseId: "watcher-superseded-1", toolName: "watcher_status", errorKind: "TOOL_ERROR", errorText: "Funzzy run 2 was superseded by run 3", label: "none" },
  { caseId: "watcher-socket-1", toolName: "watcher_status", errorKind: "TOOL_ERROR", errorText: "Funzzy on.socket is not configured in .pi/funzzy.json", label: "none" },
  { caseId: "watcher-rpc-1", toolName: "watcher_output", errorKind: "SCHEMA", errorText: "Funzzy RPC error -32602: invalid_options page mode cannot carry params.tail", label: "none" },
  { caseId: "watcher-fail-1", toolName: "watcher_verify", errorKind: "FAIL", errorText: "FAIL gen=3 target=quality gate failures=2 - Command make all has failed with exit code 2", label: "none" },
  { caseId: "watcher-stale-1", toolName: "watcher_verify", errorKind: "STALE", errorText: "STALE gen=5 target=quality gate", label: "none" },
  { caseId: "code-references-1", toolName: "code_references", errorKind: "EOPNOTSUPP", errorText: "EOPNOTSUPP: unknown error, open 'src/lib/util.ts'", label: "none" },
];
