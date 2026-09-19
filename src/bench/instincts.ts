/**
 * TASK-0025 phase 1 — corpus-derived, sanitized instinct fixtures.
 *
 * Shapes are generalized from the TASK-0023 failure catalog (real clusters,
 * sanitized content): edit mismatch variants, argument malformations, and
 * read ENOENT/EISDIR shapes. Every fixture declares its expected outcome up
 * front; the suite executes the REAL pipeline (repairArgs, preflightEdit-
 * Mismatch, repairToolResult) against a materialized fixture root — no mocks,
 * no model, fully deterministic.
 *
 * Governance: direction evidence only. Fixture results never count toward
 * promotion gates and never justify runtime changes by themselves.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { REPAIR_ACTIONS } from "../repairs/types.ts";
import { repairArgs } from "../repairs/index.ts";
import { preflightEditMismatch } from "../model-recovery/edit-mismatch.ts";
import { repairToolResult, type ToolResultShape } from "../result-repairs/index.ts";
import { recognizeReadShapedEdit } from "../read-shape.ts";

export type FixtureFamily =
  | "arg-malformation"
  | "edit-ambiguous"
  | "edit-drift"
  | "edit-noop"
  | "read-enoent"
  | "read-eisdir"
  | "read-offset-past-eof";

export interface InstinctFixture {
  fixtureId: string;
  family: FixtureFamily;
  /** Mined cluster provenance (TASK-0023 catalog), e.g. "edit/EDIT_NOT_UNIQUE x916". */
  source: string;
  toolName: "edit" | "read" | "bash";
  /** Arriving call shape (arg + edit lanes). Mutated pipeline runs on a copy. */
  toolInput?: Record<string, unknown>;
  /** Observed failure result (result-repair lanes). */
  result?: ToolResultShape;
  /** Sanitized workspace files (relative path -> synthetic content). */
  files?: Record<string, string>;
  /** Empty directories the shape needs (e.g. listing/tree context). */
  directories?: readonly string[];
  /** Repair actions the shipped pipeline is expected to fire. */
  expectedRepairs: readonly string[];
  /** True when the pipeline should deterministically resolve the failure. */
  expectResolved: boolean;
}

const TS_SNIPPET = [
  "export function alpha(input: string): string {",
  "  return input.trim();",
  "}",
  "",
  "export function beta(input: string): string {",
  "  return input.trim();",
  "}",
].join("\n");

/**
 * The frozen phase-1 suite. Order is part of the contract: identical runs
 * produce identical yields. Shapes are generalized from the TASK-0023
 * catalog; trigger contracts match the shipped rule engines exactly.
 */
export const INSTINCT_FIXTURES: readonly InstinctFixture[] = [
  // --- arg malformations (schema-shape cluster) ---
  {
    fixtureId: "arg-parse-json-edits",
    family: "arg-malformation",
    source: "edit/SCHEMA stringified edits array",
    toolName: "edit",
    toolInput: { path: "src/example.ts", edits: '[{"oldText": "alpha", "newText": "gamma"}]' },
    expectedRepairs: ["parse-json"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-wrap-object-array",
    family: "arg-malformation",
    source: "edit/SCHEMA single object instead of edits array",
    toolName: "edit",
    toolInput: { path: "src/example.ts", edits: { oldText: "alpha", newText: "gamma" } },
    expectedRepairs: ["wrap-object-array"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-wrap-array-string",
    family: "arg-malformation",
    source: "edit/SCHEMA bare string instead of edits array",
    toolName: "edit",
    toolInput: { path: "src/example.ts", edits: "alpha" },
    expectedRepairs: ["wrap-array"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-nest-edit-fields",
    family: "arg-malformation",
    source: "edit/EDIT_INVALID_SHAPE x370 flat oldText/newText",
    toolName: "edit",
    toolInput: { path: "src/example.ts", oldText: "alpha", newText: "gamma" },
    expectedRepairs: ["nest-edit-fields"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-rename-aliased-field",
    family: "arg-malformation",
    source: "read|edit/SCHEMA aliased path field",
    toolName: "edit",
    toolInput: { file: "src/example.ts", edits: [{ oldText: "alpha", newText: "gamma" }] },
    expectedRepairs: ["rename-aliased-field"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-relational-default",
    family: "arg-malformation",
    source: "read/SCHEMA limit without offset",
    toolName: "read",
    toolInput: { file: "src/example.ts", limit: 10 },
    expectedRepairs: ["rename-aliased-field", "relational-default"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-clean-path-and-coerce-number",
    family: "arg-malformation",
    source: "read/SCHEMA markdown-wrapped path + stringified pagination",
    toolName: "read",
    toolInput: { path: "[src/example.ts](src/example.ts)", offset: "5" },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: ["clean-path", "coerce-number", "relational-default"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-strip-extra-props",
    family: "arg-malformation",
    source: "edit/SCHEMA invented edit-item field",
    toolName: "edit",
    toolInput: { path: "src/example.ts", edits: [{ oldText: "alpha", newText: "gamma", lineNumber: 3 }] },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: ["strip-extra-props"],
    expectResolved: true,
  },
  {
    fixtureId: "arg-drop-noop-edit",
    family: "arg-malformation",
    source: "edit/EDIT_NOOP mixed no-op batch",
    toolName: "edit",
    toolInput: {
      path: "src/example.ts",
      edits: [
        { oldText: "alpha", newText: "alpha" },
        { oldText: "alpha", newText: "gamma" },
      ],
    },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: ["drop-noop-edit"],
    expectResolved: true,
  },

  // --- edit ambiguity (EDIT_NOT_UNIQUE, catalog rank 1) ---
  {
    fixtureId: "edit-ambiguous-excluded-by-anchor",
    family: "edit-ambiguous",
    source: "edit/EDIT_NOT_UNIQUE x916 (batch anchor excludes one occurrence)",
    toolName: "edit",
    toolInput: {
      path: "src/config.ts",
      edits: [
        { oldText: "  timeout?: number;\n}", newText: "  timeout?: number;\n  grace?: number;\n}" },
        {
          oldText: "  timeout?: number;\n}\n\ninterface Ledger",
          newText: "  timeout?: number;\n  grace?: number;\n}\n\ninterface Ledger",
        },
      ],
    },
    files: {
      "src/config.ts": [
        "interface Session {",
        "  timeout?: number;",
        "}",
        "",
        "interface Profile {",
        "  timeout?: number;",
        "}",
        "",
        "interface Ledger {}",
      ].join("\n"),
    },
    expectedRepairs: ["resolve-ambiguous-edit"],
    expectResolved: true,
  },
  {
    fixtureId: "edit-ambiguous-multiple-viable",
    family: "edit-ambiguous",
    source: "edit/EDIT_NOT_UNIQUE x916 (negative control)",
    toolName: "edit",
    toolInput: {
      path: "src/twin.ts",
      edits: [{ oldText: "  return input.trim();", newText: "  return input.trimEnd();" }],
    },
    files: {
      "src/twin.ts": [
        "export function one(value: string): string {",
        "  return input.trim();",
        "}",
        "",
        "export function two(value: string): string {",
        "  return input.trim();",
        "}",
      ].join("\n"),
    },
    expectedRepairs: [],
    expectResolved: false,
  },

  // --- edit drift (EDIT_NOT_FOUND, catalog rank 2) ---
  {
    fixtureId: "edit-drift-indent-unique",
    family: "edit-drift",
    source: "edit/TOOL_ERROR+EDIT_NOT_FOUND x2201 (whitespace drift)",
    toolName: "edit",
    toolInput: {
      path: "src/single.ts",
      edits: [{ oldText: "return  input.trim();", newText: "return  input.trimEnd();" }],
    },
    files: {
      "src/single.ts": [
        "export function alpha(input: string): string {",
        "  return input.trim();",
        "}",
      ].join("\n"),
    },
    expectedRepairs: ["resolve-ambiguous-edit"],
    expectResolved: true,
  },
  {
    fixtureId: "edit-drift-stale",
    family: "edit-drift",
    source: "edit/TOOL_ERROR+EDIT_NOT_FOUND x2201 (negative control)",
    toolName: "edit",
    toolInput: {
      path: "src/example.ts",
      edits: [{ oldText: "return input.toUpperCase();", newText: "return input.trimEnd();" }],
    },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: [],
    expectResolved: false,
  },

  // --- read-shaped edit (TASK-0028: call-time shape restoration) ---
  {
    fixtureId: "edit-read-shaped-offset",
    family: "edit-ambiguous",
    source: "edit/EDIT_INVALID_SHAPE x370 read args (path + offset/limit)",
    toolName: "edit",
    toolInput: { path: "src/example.ts", offset: 3, limit: 5 },
    expectedRepairs: ["restore-read-shape"],
    expectResolved: true,
  },
  {
    fixtureId: "edit-read-shaped-range",
    family: "edit-ambiguous",
    source: "edit/EDIT_INVALID_SHAPE x370 read args (path + startLine/endLine)",
    toolName: "edit",
    toolInput: { path: "src/example.ts", startLine: 3, endLine: 7 },
    expectedRepairs: ["restore-read-shape"],
    expectResolved: true,
  },

  // --- result-repair shapes ---
  {
    fixtureId: "edit-noop-verified",
    family: "edit-noop",
    source: "edit/EDIT_NOOP identical replacement",
    toolName: "edit",
    result: {
      toolName: "edit",
      isError: true,
      input: { path: "src/example.ts", edits: [{ oldText: "alpha", newText: "alpha" }] },
      content: [{ type: "text", text: "No changes made. The replacement produced identical content." }],
    },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: ["edit-noop"],
    expectResolved: true,
  },
  {
    fixtureId: "read-enoent-with-context",
    family: "read-enoent",
    source: "read/ENOENT x1409",
    toolName: "read",
    result: {
      toolName: "read",
      isError: true,
      input: { path: "docs/notes/summary.md" },
      content: [{ type: "text", text: "File not found: docs/notes/summary.md (ENOENT)" }],
    },
    files: { "docs/notes/summary-draft.md": "draft notes\n" },
    expectedRepairs: ["missing-read-context"],
    expectResolved: false,
  },
  {
    fixtureId: "read-eisdir",
    family: "read-eisdir",
    source: "read/EISDIR x52",
    toolName: "read",
    result: {
      toolName: "read",
      isError: true,
      input: { path: "docs" },
      content: [{ type: "text", text: "EISDIR: illegal operation on a directory, read" }],
    },
    directories: ["docs"],
    files: { "docs/index.md": "index\n" },
    expectedRepairs: ["directory-read"],
    expectResolved: true,
  },
  {
    fixtureId: "read-offset-past-eof",
    family: "read-offset-past-eof",
    source: "read/OFFSET past EOF cluster",
    toolName: "read",
    result: {
      toolName: "read",
      isError: true,
      input: { path: "src/example.ts", offset: 900, limit: 10 },
      content: [{ type: "text", text: "Offset 900 is beyond end of file (7 lines total)" }],
    },
    files: { "src/example.ts": TS_SNIPPET },
    expectedRepairs: ["read-offset-context"],
    expectResolved: true,
  },
];

// --- execution ------------------------------------------------------------------

export interface FixtureRun {
  fixtureId: string;
  family: FixtureFamily;
  /** Fired repair actions, in pipeline order. */
  actions: string[];
  /** True when the failure was deterministically resolved (not merely enriched). */
  resolved: boolean;
  /** True when fired actions and resolution match the declared expectation. */
  matchesExpectation: boolean;
}

/**
 * Runs every fixture against `root`: files/directories are materialized
 * deterministically, then the real pipeline executes. No model, no network.
 */
export async function runFixtureSuite(fixtures: readonly InstinctFixture[], root: string): Promise<FixtureRun[]> {
  const runs: FixtureRun[] = [];
  for (const fixture of fixtures) {
    await materialize(fixture, root);
    runs.push(await runFixture(fixture, root));
  }
  return runs;
}

async function materialize(fixture: InstinctFixture, root: string): Promise<void> {
  for (const directory of fixture.directories ?? []) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [relativePath, content] of Object.entries(fixture.files ?? {})) {
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

async function runFixture(fixture: InstinctFixture, root: string): Promise<FixtureRun> {
  const actions: string[] = [];
  let resolved = false;

  if (fixture.toolInput) {
    // Call-time shape restoration runs before repairArgs in the live pipeline.
    if (fixture.toolName === "edit" && recognizeReadShapedEdit(fixture.toolInput)) {
      actions.push("restore-read-shape");
      resolved = true;
    } else {
      // Copy: repairArgs mutates nested structures in place.
      const argResult = repairArgs(structuredClone(fixture.toolInput), { toolName: fixture.toolName });
      actions.push(...argResult.repairs.map((repair) => repair.action));
      // An arg repair fixes the arriving shape; that is the resolution for the
      // arg lane. Edit inputs additionally run the deterministic preflight.
      resolved = argResult.repairs.length > 0;
      if (fixture.toolName === "edit") {
        const preflight = await preflightEditMismatch({ toolInput: argResult.result, cwd: root });
        if (preflight) {
          actions.push("resolve-ambiguous-edit");
          resolved = true;
        }
      }
    }
  } else if (fixture.result) {
    const repair = await repairToolResult(fixture.result, root);
    if (repair) {
      actions.push(...repair.repairs.map((repairAction) => repairAction.action));
      resolved = repair.patch.isError === false;
    }
  }

  const expectedActions = [...fixture.expectedRepairs].sort();
  const actualActions = [...actions].sort();
  const matchesExpectation =
    actualActions.length === expectedActions.length &&
    actualActions.every((action, index) => action === expectedActions[index]) &&
    resolved === fixture.expectResolved;

  return { fixtureId: fixture.fixtureId, family: fixture.family, actions, resolved, matchesExpectation };
}

// --- yield metric ----------------------------------------------------------------

export interface RuleYield {
  rule: string;
  /** Fixtures declared to exercise this rule. */
  eligibleFixtures: number;
  /** Fixtures where the rule actually fired. */
  fired: number;
  yieldRate: number;
}

export interface YieldReport {
  label: "direction evidence only";
  total: number;
  resolved: number;
  matchedExpectations: number;
  /** One entry per active repair action, including never-fired rules. */
  rules: readonly RuleYield[];
  /** Active rules that never fired across the whole suite. */
  deadRules: readonly string[];
}

/** Per-rule repair yield over the suite; deterministic given identical runs. */
export function buildYieldReport(fixtures: readonly InstinctFixture[], runs: readonly FixtureRun[]): YieldReport {
  const runByFixture = new Map(runs.map((run) => [run.fixtureId, run]));
  const firedByRule = new Map<string, number>();
  for (const run of runs) {
    for (const action of new Set(run.actions)) {
      firedByRule.set(action, (firedByRule.get(action) ?? 0) + 1);
    }
  }

  const rules: RuleYield[] = REPAIR_ACTIONS.map((rule) => {
    const eligible = fixtures.filter((fixture) => fixture.expectedRepairs.includes(rule)).length;
    const fired = firedByRule.get(rule) ?? 0;
    return { rule, eligibleFixtures: eligible, fired, yieldRate: eligible === 0 ? 0 : fired / eligible };
  });

  return {
    label: "direction evidence only",
    total: runs.length,
    resolved: runs.filter((run) => run.resolved).length,
    matchedExpectations: runs.filter((run) => run.matchesExpectation).length,
    rules,
    deadRules: rules.filter((rule) => rule.fired === 0).map((rule) => rule.rule),
  };
}
