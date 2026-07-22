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

test("listDirectoryForRead uses injected filesystem", async () => {
  const calls: string[] = [];
  const result = await listDirectoryForRead("folder", "/cwd", {
    async stat(target) {
      calls.push(`stat:${target}`);
      return { isDirectory: () => true };
    },
    async readdir(target) {
      calls.push(`readdir:${target}`);
      return [
        { name: "z-file", isDirectory: () => false },
        { name: "a-folder", isDirectory: () => true },
      ];
    },
    async readFile() { throw new Error("unused"); },
    async writeFile() { throw new Error("unused"); },
  });

  assert.deepEqual(calls, ["stat:/cwd/folder", "readdir:/cwd/folder"]);
  assert.match(result?.content[0]?.text ?? "", /a-folder\/\nz-file$/);
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
