import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendMissingReadContext } from "./missing-read-context.ts";

test("appendMissingReadContext shows a bounded tree from the requested folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-missing-read-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "existing.ts"), "x");
  await writeFile(path.join(root, "src", "nested", "index.ts"), "x");

  const result = await appendMissingReadContext({
    toolName: "read",
    input: { path: "src/missing.ts" },
    isError: true,
    content: "ENOENT: no such file or directory",
  }, root);

  assert.equal(result?.isError, true);
  assert.match(result?.content[0]?.text ?? "", /ENOENT: no such file or directory/);
  assert.match(result?.content[0]?.text ?? "", /Requested path: src\/missing\.ts/);
  assert.match(result?.content[0]?.text ?? "", new RegExp(`Tree from: ${escapeRegExp(path.join(root, "src"))}`));
  assert.match(result?.content[0]?.text ?? "", /existing\.ts/);
  assert.match(result?.content[0]?.text ?? "", /nested\//);
  assert.match(result?.content[0]?.text ?? "", /index\.ts/);
  assert.deepEqual(result?.details.missingReadContext, {
    requestedPath: "src/missing.ts",
    treeRoot: path.join(root, "src"),
    entries: 3,
    truncated: false,
  });
});

test("appendMissingReadContext falls back to the nearest existing ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-missing-read-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "actual.ts"), "x");

  const result = await appendMissingReadContext({
    toolName: "read",
    input: { path: "src/removed/missing.ts" },
    isError: true,
    content: [{ type: "text", text: "ENOENT: missing" }],
  }, root);

  assert.equal(result?.details.missingReadContext.treeRoot, path.join(root, "src"));
  assert.match(result?.content[0]?.text ?? "", /actual\.ts/);
});

test("appendMissingReadContext caps large folder trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-missing-read-"));
  await Promise.all(Array.from({ length: 85 }, (_, index) => (
    writeFile(path.join(root, `${String(index).padStart(3, "0")}.ts`), "x")
  )));

  const result = await appendMissingReadContext({
    toolName: "read",
    input: { path: "missing.ts" },
    isError: true,
    content: "ENOENT",
  }, root);

  assert.equal(result?.details.missingReadContext.entries, 80);
  assert.equal(result?.details.missingReadContext.truncated, true);
  assert.match(result?.content[0]?.text ?? "", /tree truncated/);
  assert.doesNotMatch(result?.content[0]?.text ?? "", /084\.ts/);
});

test("appendMissingReadContext ignores unrelated and non-missing reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-missing-read-"));
  const existing = path.join(root, "existing.ts");
  await writeFile(existing, "x");

  assert.equal(await appendMissingReadContext({
    toolName: "bash", input: { path: "missing.ts" }, isError: true, content: "ENOENT",
  }, root), undefined);
  assert.equal(await appendMissingReadContext({
    toolName: "read", input: { path: existing }, isError: true, content: "permission denied",
  }, root), undefined);
  assert.equal(await appendMissingReadContext({
    toolName: "read", input: { path: existing }, isError: true, content: "ENOENT",
  }, root), undefined);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
