import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRoutingState, sanitizeRoutingText, MAX_ROUTING_TEXT_BYTES } from "./sanitize.ts";

test("redacts credentials, paths, quoted values, and source lines", () => {
  const raw = [
    "Could not find edits[0] in /Users/example/project/src/app/config.ts.",
    "apiKey: sk-secret-value-1234567890",
    'the string "some literal" was rejected',
    "const value = computeSomething(input);",
  ].join(" ");

  const sanitized = sanitizeRoutingText(raw)!;
  assert.ok(sanitized);
  assert.doesNotMatch(sanitized, /Users\//);
  assert.doesNotMatch(sanitized, /src\/app\/config\.ts/);
  assert.doesNotMatch(sanitized, /sk-secret-value/);
  assert.doesNotMatch(sanitized, /some literal/);
  assert.doesNotMatch(sanitized, /computeSomething/);
  assert.match(sanitized, /<path>/);
});

test("drops unsanitizable, control-character, and empty inputs", () => {
  assert.equal(sanitizeRoutingText("bad\u0000text"), undefined);
  assert.equal(sanitizeRoutingText("   "), undefined);
  assert.equal(sanitizeRoutingText(""), undefined);
});

test("caps the transmitted text and collapses whitespace deterministically", () => {
  const long = `ENOENT: no such file\n\n${"x".repeat(900)}`;
  const sanitized = sanitizeRoutingText(long)!;
  assert.ok(Buffer.byteLength(sanitized, "utf8") <= MAX_ROUTING_TEXT_BYTES);
  assert.equal(sanitized, sanitizeRoutingText(long));
});

test("buildRoutingState carries only toolName, errorKind, and sanitized text", () => {
  const state = buildRoutingState({
    toolName: "edit",
    errorKind: "EDIT_NOT_FOUND",
    errorText: "Could not find edits[0] in /Users/example/secret/project/file.ts.",
  })!;
  assert.deepEqual(Object.keys(state).sort(), ["errorKind", "errorText", "toolName"]);
  assert.doesNotMatch(JSON.stringify(state), /Users|secret|file\.ts/);
});
