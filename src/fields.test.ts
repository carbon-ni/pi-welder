import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isArrayField,
  isBooleanField,
  isNumberField,
  isPathField,
} from "./fields.ts";

test("classifies explicit path fields", () => {
  assert.equal(isPathField("path"), true);
  assert.equal(isPathField("filePath"), true);
  assert.equal(isPathField("name"), false);
});

test("classifies explicit and heuristic array fields", () => {
  assert.equal(isArrayField("edits"), true);
  assert.equal(isArrayField("function_names"), true);
  assert.equal(isArrayField("widgetList"), true);
  assert.equal(isArrayField("selected_items"), true);
  assert.equal(isArrayField("name"), false);
});

test("classifies explicit and heuristic boolean fields", () => {
  assert.equal(isBooleanField("strict"), true);
  assert.equal(isBooleanField("is_enabled"), true);
  assert.equal(isBooleanField("has_cache"), true);
  assert.equal(isBooleanField("can_retry"), true);
  assert.equal(isBooleanField("feature_flag"), true);
  assert.equal(isBooleanField("status"), false);
});

test("classifies explicit and heuristic number fields", () => {
  assert.equal(isNumberField("limit"), true);
  assert.equal(isNumberField("maxDepth"), true);
  assert.equal(isNumberField("minScore"), true);
  assert.equal(isNumberField("retry_count"), true);
  assert.equal(isNumberField("page_size"), true);
  assert.equal(isNumberField("selected_index"), true);
  assert.equal(isNumberField("label"), false);
});
