import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRepairWarnings,
  clearRepairWarnings,
  consumeRepairWarnings,
  createRepairWarningState,
  recordRepairWarnings,
  repairWarningsSummary,
} from "./repair-warnings.ts";
import type { Repair } from "./repairs/index.ts";

test("buildRepairWarnings returns empty when no warnings recorded", () => {
  assert.deepEqual(buildRepairWarnings(createRepairWarningState()), []);
});

test("buildRepairWarnings produces a single system message with hints", () => {
  const state = createRepairWarningState();
  recordRepairWarnings(state, [
    { field: "input.edits", action: "wrap-object-array" },
    { field: "input.offset", action: "coerce-number" },
  ], "edit");

  const messages = buildRepairWarnings(state);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /pi-welder repair hints/);
  assert.match(messages[0]?.content ?? "", /wrap-object-array/);
  assert.match(messages[0]?.content ?? "", /coerce-number/);
});

test("buildRepairWarnings maps every repair action to a human hint", () => {
  const state = createRepairWarningState();
  const repairs: Repair[] = [
    { field: "input.a", action: "strip-null" },
    { field: "input.b", action: "strip-null-like" },
    { field: "input.c", action: "clean-path" },
    { field: "input.d", action: "parse-json" },
    { field: "input.e", action: "wrap-array" },
    { field: "input.f", action: "wrap-object-array" },
    { field: "input.g", action: "split-string" },
    { field: "input.h", action: "coerce-boolean" },
    { field: "input.i", action: "coerce-number" },
    { field: "input.j", action: "strip-extra-props" },
    { field: "input.k", action: "rename-aliased-field" },
    { field: "input.l", action: "relational-default" },
    { field: "input.m", action: "nest-edit-fields" },
  ];
  recordRepairWarnings(state, repairs, "bash");

  const messages = buildRepairWarnings(state);
  const content = messages[0]?.content ?? "";

  assert.match(content, /pi-welder repair hints/);
  // Spot-check a few specific hints
  assert.match(content, /strip-null/);
  assert.match(content, /null-like/);
  assert.match(content, /markdown link/);
  assert.match(content, /JSON/);
  assert.match(content, /wrap single objects/);
  assert.match(content, /coerce-boolean/);
  assert.match(content, /rename-aliased-field/);
  assert.match(content, /relational-default/);
  assert.match(content, /nest-edit-fields/);
});

test("consumeRepairWarnings injects once for an unchanged snapshot", () => {
  const state = createRepairWarningState();
  recordRepairWarnings(state, [{ field: "input.x", action: "wrap-array" }], "read");

  const first = consumeRepairWarnings(state);
  const second = consumeRepairWarnings(state);

  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
});

test("consumeRepairWarnings injects again when new warnings arrive", () => {
  const state = createRepairWarningState();
  recordRepairWarnings(state, [{ field: "input.a", action: "coerce-boolean" }], "bash");
  assert.equal(consumeRepairWarnings(state).length, 1);
  assert.equal(consumeRepairWarnings(state).length, 0);

  recordRepairWarnings(state, [{ field: "input.b", action: "parse-json" }], "write");
  assert.equal(consumeRepairWarnings(state).length, 1);
});

test("clearRepairWarnings removes warnings and delivered snapshot", () => {
  const state = createRepairWarningState();
  recordRepairWarnings(state, [{ field: "input.x", action: "wrap-array" }], "read");
  assert.equal(consumeRepairWarnings(state).length, 1);

  clearRepairWarnings(state);

  assert.equal(state.warnings.length, 0);
  assert.equal(state.deliveredSnapshot, null);
  assert.deepEqual(buildRepairWarnings(state), []);
});

test("repairWarningsSummary renders pending warnings", () => {
  const state = createRepairWarningState();
  recordRepairWarnings(state, [
    { field: "input.path", action: "clean-path" },
    { field: "input.edits", action: "wrap-object-array" },
  ], "edit");

  const summary = repairWarningsSummary(state);

  assert.match(summary, /pending repair warnings/);
  assert.match(summary, /clean-path/);
  assert.match(summary, /wrap-object-array/);
});

test("repairWarningsSummary handles empty state", () => {
  assert.equal(repairWarningsSummary(createRepairWarningState()), "pi-welder: no pending repair warnings");
});

test("recordRepairWarnings deduplicates by action per field within a single call", () => {
  const state = createRepairWarningState();
  // Same field+action should only appear once in the warning message
  recordRepairWarnings(state, [
    { field: "input.x", action: "coerce-number" },
    { field: "input.x", action: "coerce-number" },
  ], "read");

  const messages = buildRepairWarnings(state);
  const content = messages[0]?.content ?? "";
  // Count occurrences of coerce-number — should only appear once
  const matches = content.match(/coerce-number/g);
  assert.equal(matches?.length ?? 0, 1);
});

test("too many warning records get capped by maxWarnings", () => {
  const state = createRepairWarningState(2);
  recordRepairWarnings(state, [{ field: "input.a", action: "coerce-boolean" }], "bash");
  recordRepairWarnings(state, [{ field: "input.b", action: "clean-path" }], "bash");
  recordRepairWarnings(state, [{ field: "input.c", action: "parse-json" }], "bash");
  recordRepairWarnings(state, [{ field: "input.d", action: "wrap-array" }], "bash");

  // Only the last 2 batches are kept
  const messages = buildRepairWarnings(state);
  const content = messages[0]?.content ?? "";
  assert.match(content, /parse-json/);
  assert.match(content, /wrap-array/);
  // Older batches should not appear
  assert.ok(!content.includes("coerce-boolean"), "older coerce-boolean was evicted");
  assert.ok(!content.includes("clean-path"), "older clean-path was evicted");
});
