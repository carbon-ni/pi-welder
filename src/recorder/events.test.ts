import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyErrorKind } from "./events.ts";

test("classifyErrorKind distinguishes deterministic edit failures", () => {
  const examples = [
    ["Found 2 occurrences of edits[0]. Each oldText must be unique.", "EDIT_NOT_UNIQUE"],
    ["Could not find edits[0]. The oldText must match exactly.", "EDIT_NOT_FOUND"],
    ["No changes made. The replacement produced identical content.", "EDIT_NOOP"],
    ["edits[1] and edits[2] overlap in file.ts.", "EDIT_OVERLAP"],
    ["Validation failed for tool \"edit\": path is required", "EDIT_INVALID_SHAPE"],
    ["edits[0].oldText must not be empty", "EDIT_EMPTY_ANCHOR"],
  ] as const;

  for (const [errorText, expected] of examples) {
    assert.equal(classifyErrorKind(errorText), expected, errorText);
  }
});

test("classifyErrorKind keeps explicit uppercase kinds authoritative", () => {
  assert.equal(classifyErrorKind("EDIT_MISMATCH: oldText not found"), "EDIT_MISMATCH");
});
