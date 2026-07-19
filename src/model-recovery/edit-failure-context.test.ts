import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendEditFailureContext } from "./edit-failure-context.ts";

const mismatch = (target: string, edits: Array<{ oldText: string; newText: string }>, content: string) => ({
  toolName: "edit",
  input: { path: target, edits },
  isError: true,
  content,
});

test("appends every exact candidate section for an ambiguous failed edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-edit-context-"));
  const current = [
    "function first() {",
    "  return 1;",
    "}",
    "",
    "function second() {",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  await writeFile(path.join(root, "file.ts"), current);

  const patch = await appendEditFailureContext(mismatch(
    "file.ts",
    [{ oldText: "  return 1;", newText: "  return 2;" }],
    "Found 2 occurrences of edits[0] in file.ts. Each oldText must be unique.",
  ), root);
  const text = patch?.content[0]?.text ?? "";

  assert.equal(patch?.isError, true);
  assert.match(text, /Fresh current-file context for edits\[0\]/);
  assert.match(text, /candidate 1\/2/);
  assert.match(text, /candidate 2\/2/);
  assert.match(text, /function first/);
  assert.match(text, /function second/);
});

test("locates a likely current section when oldText no longer matches exactly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-edit-context-"));
  await writeFile(path.join(root, "file.ts"), [
    "export function unrelated() {}",
    "",
    "export function calculateTotal(value: number) {",
    "  const currentTotal = value * 2;",
    "  return currentTotal;",
    "}",
    "",
  ].join("\n"));

  const patch = await appendEditFailureContext(mismatch(
    "file.ts",
    [{
      oldText: "export function calculateTotal(value:number) {\n  const total=value*2;\n  return total;\n}",
      newText: "export function calculateTotal(value: number) {\n  return value * 3;\n}",
    }],
    "Could not find edits[0] in file.ts. The oldText must match exactly.",
  ), root);
  const text = patch?.content[0]?.text ?? "";

  assert.match(text, /match: likely section/);
  assert.match(text, /export function calculateTotal\(value: number\)/);
  assert.doesNotMatch(text, /No fresh context found/);
});

test("keeps generated failure context bounded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-edit-context-"));
  const current = Array.from({ length: 100 }, (_, index) => `function item${index}() {\n  return shared;\n}\n`).join("\n");
  await writeFile(path.join(root, "file.ts"), current);

  const patch = await appendEditFailureContext(mismatch(
    "file.ts",
    [{ oldText: "  return shared;", newText: "  return changed;" }],
    "Found 100 occurrences of edits[0] in file.ts. Each oldText must be unique.",
  ), root);
  const text = patch?.content[0]?.text ?? "";

  assert.ok(Buffer.byteLength(text, "utf8") <= 16_000);
  assert.match(text, /additional candidate section\(s\) omitted/);
});

test("leaves unrelated, unreadable, and oversized failures unchanged", async () => {
  assert.equal(await appendEditFailureContext({
    toolName: "bash", input: {}, isError: true, content: "failed",
  }, process.cwd()), undefined);

  assert.equal(await appendEditFailureContext(mismatch(
    "missing.ts",
    [{ oldText: "x", newText: "y" }],
    "Could not find edits[0]. The oldText must match exactly.",
  ), process.cwd()), undefined);

  const root = await mkdtemp(path.join(tmpdir(), "welder-edit-context-"));
  await writeFile(path.join(root, "large.ts"), `target\n${"x".repeat(200_001)}`);
  assert.equal(await appendEditFailureContext(mismatch(
    "large.ts",
    [{ oldText: "target", newText: "next" }],
    "Could not find edits[0]. The oldText must match exactly.",
  ), root), undefined);
});
