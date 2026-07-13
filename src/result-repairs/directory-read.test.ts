import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

import { listDirectoryForRead, resolveReadPath } from "./directory-read.ts";

test("listDirectoryForRead returns sorted files and folders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-dir-"));
  await mkdir(path.join(root, "z-folder"));
  await writeFile(path.join(root, "a-file.ts"), "x");

  const result = await listDirectoryForRead(root, root);

  assert.deepEqual(result, {
    content: [{ type: "text", text: `Directory: ${root}\n\na-file.ts\nz-folder/` }],
    details: { path: root, entries: 2, truncated: false },
    isError: false,
  });
});

test("listDirectoryForRead returns undefined for files and missing paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-dir-"));
  const file = path.join(root, "file.txt");
  await writeFile(file, "x");

  assert.equal(await listDirectoryForRead(file, root), undefined);
  assert.equal(await listDirectoryForRead(path.join(root, "missing"), root), undefined);
});

test("resolveReadPath expands home and resolves relative paths", () => {
  assert.equal(resolveReadPath("~/project", "/cwd"), path.join(homedir(), "project"));
  assert.equal(resolveReadPath("src", "/cwd"), path.join("/cwd", "src"));
});
