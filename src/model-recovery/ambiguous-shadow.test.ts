import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAmbiguousShadowRequest, redactShadowText } from "./ambiguous-shadow.ts";

function fileSystem(content: string, realPath?: string | ((p: string) => Promise<string>)) {
  const realpath = typeof realPath === "function" ? realPath : async (p: string) => realPath ?? p;
  return { readFile: async () => content, realpath } as any;
}

const baseInput = {
  path: "src/example.ts",
  edits: [{ oldText: "return value;", newText: "return nextValue;" }],
};

test("builds an ordinal candidate request only for 2 to 5 exact matches", async () => {
  const result = await buildAmbiguousShadowRequest({
    cwd: "/repo",
    toolInput: baseInput,
    fileSystem: fileSystem("function a() { return value; }\nfunction b() { return value; }\n"),
  });

  assert.ok(result);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.ordinal), [1, 2]);
  assert.equal(result.requestedEditText, "return nextValue;");
  assert.ok(result.serializedBytes <= 12 * 1024);
});

test("rejects clean, missing, and over-limit inputs", async () => {
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: { ...baseInput, edits: [{ ...baseInput.edits[0]!, oldText: "missing" }] }, fileSystem: fileSystem("x") }), undefined);
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: { ...baseInput, edits: [{ ...baseInput.edits[0]!, oldText: "return value;" }] }, fileSystem: fileSystem("return value;" ) }), undefined);
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: baseInput, fileSystem: fileSystem("x".repeat(200_001)) }), undefined);
});

test("rejects more than five candidates and malformed or multi-edit input", async () => {
  const six = Array.from({ length: 6 }, (_, i) => `line${i}: value`).join("\n");
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: { path: "x", edits: [{ oldText: "value", newText: "next" }] }, fileSystem: fileSystem(six) }), undefined);
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: { path: "x", edits: [{ oldText: "value", newText: "next" }, { oldText: "x", newText: "y" }] }, fileSystem: fileSystem("value\nvalue") }), undefined);
});

test("caps windows to twenty lines and two kibibytes", async () => {
  const line = "a".repeat(100);
  const content = Array.from({ length: 50 }, (_, i) => `${i === 25 ? "return value;" : line}`).join("\n");
  const result = await buildAmbiguousShadowRequest({
    cwd: "/repo",
    toolInput: baseInput,
    fileSystem: fileSystem(`${content}\n${content}`),
  });
  assert.ok(result);
  for (const candidate of result.candidates) {
    assert.ok((candidate.window ?? "").split("\n").length <= 20);
    assert.ok(Buffer.byteLength(candidate.window ?? "", "utf8") <= 2 * 1024);
  }
});

test("redacts credentials and rejects unsafe control text", () => {
  assert.match(redactShadowText("apiKey = sk-secret-value") ?? "", /<redacted>/);
  assert.doesNotMatch(redactShadowText("apiKey = sk-secret-value") ?? "", /sk-secret-value/);
  assert.equal(redactShadowText("safe\u0000text"), undefined);
});

test("fails closed when sanitization makes a candidate impossible to transmit", async () => {
  const result = await buildAmbiguousShadowRequest({
    cwd: "/repo",
    toolInput: { ...baseInput, edits: [{ oldText: "secret", newText: "next" }] },
    fileSystem: fileSystem("secret\nsecret"),
    sanitize: () => undefined,
  });
  assert.equal(result, undefined);
});

test("rejects paths outside cwd, the cwd root itself, and unreadable symlinks", async () => {
  const contained = await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: baseInput, fileSystem: fileSystem("return value;\nreturn value;") });
  assert.ok(contained);

  const outside = fileSystem("return value;\nreturn value;", "/etc/passwd");
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: baseInput, fileSystem: outside }), undefined);

  const rootItself = fileSystem("return value;\nreturn value;", "/repo");
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: { ...baseInput, path: "." }, fileSystem: rootItself }), undefined);

  const noRealpath = { readFile: async () => "a\na" } as any;
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: baseInput, fileSystem: noRealpath }), undefined);

  const symlinkBreaks = { readFile: async () => "a\na", realpath: async () => Promise.reject(new Error("missing")) } as any;
  assert.equal(await buildAmbiguousShadowRequest({ cwd: "/repo", toolInput: baseInput, fileSystem: symlinkBreaks }), undefined);
});
