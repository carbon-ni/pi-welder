import { test } from "node:test";
import assert from "node:assert/strict";

import { REPAIR_NAMES, isKnownRepairName } from "./repair-names.ts";

test("REPAIR_NAMES covers input rules, object rules, result rules, and edit preflight", () => {
  const names = new Set(REPAIR_NAMES);
  // inline input repairs
  assert.ok(names.has("strip-null"));
  assert.ok(names.has("strip-null-like"));
  // field rules (incl. the array-shape group rule)
  assert.ok(names.has("clean-path"));
  assert.ok(names.has("parse-json"));
  assert.ok(names.has("array-shape"));
  // object rules
  assert.ok(names.has("nest-edit-fields"));
  assert.ok(names.has("merge-edit-anchor"));
  assert.ok(names.has("drop-noop-edit"));
  // result repairs
  assert.ok(names.has("directory-read"));
  assert.ok(names.has("missing-read-context"));
  assert.ok(names.has("read-offset-context"));
  assert.ok(names.has("edit-noop"));
  // edit preflight
  assert.ok(names.has("resolve-ambiguous-edit"));
  // call-time shape restoration
  assert.ok(names.has("restore-read-shape"));
});

test("REPAIR_NAMES has no duplicates", () => {
  assert.equal(REPAIR_NAMES.length, new Set(REPAIR_NAMES).size);
});

test("isKnownRepairName answers membership", () => {
  assert.equal(isKnownRepairName("parse-json"), true);
  assert.equal(isKnownRepairName("nope"), false);
});
