import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { repairToolResult } from "./engine.ts";

test("repairToolResult returns a uniform directory-read repair signal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-result-"));
  await mkdir(path.join(root, "folder"));

  const repair = await repairToolResult({
    toolName: "read",
    input: { path: root },
    isError: true,
  }, root);

  assert.equal(repair?.patch.isError, false);
  assert.deepEqual(repair?.repairs, [{ field: "path", action: "directory-read" }]);
});

test("repairToolResult recovers a read offset past EOF", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-result-"));
  await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree");

  const repair = await repairToolResult({
    toolName: "read",
    input: { path: "notes.txt", offset: 5, limit: 2 },
    isError: true,
    content: "Offset 5 is beyond end of file (3 lines total)",
  }, root);

  assert.equal(repair?.patch.isError, false);
  assert.deepEqual(repair?.repairs, [{ field: "offset", action: "read-offset-context" }]);
  assert.match(repair?.patch.content[0]?.text ?? "", /two\nthree$/);
});

test("repairToolResult adds nearest-folder context to missing reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-result-"));
  await mkdir(path.join(root, "src"));

  const repair = await repairToolResult({
    toolName: "read",
    input: { path: "src/missing.ts" },
    isError: true,
    content: "ENOENT: no such file or directory",
  }, root);

  assert.equal(repair?.patch.isError, true);
  assert.deepEqual(repair?.repairs, [{ field: "path", action: "missing-read-context" }]);
});

test("repairToolResult leaves unrelated failures unchanged", async () => {
  assert.equal(await repairToolResult({
    toolName: "bash", input: {}, isError: true,
  }, process.cwd()), undefined);
});
