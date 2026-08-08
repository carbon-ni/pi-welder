import { test } from "node:test";
import assert from "node:assert/strict";

import type { FileSystem } from "../infra/filesystem.ts";
import { recoverReadOffsetContext } from "./read-offset-context.ts";

function fileSystemWith(content: string): FileSystem {
  return {
    async readFile() { return content; },
    async writeFile() { throw new Error("unused"); },
    async stat() { return { isDirectory: () => false }; },
    async readdir() { throw new Error("unused"); },
  };
}

test("recoverReadOffsetContext returns requested final page from current file", async () => {
  const result = await recoverReadOffsetContext({
    toolName: "read",
    input: { path: "notes.txt", offset: 9, limit: 3 },
    isError: true,
    content: "Offset 9 is beyond end of file (5 lines total)",
  }, "/workspace", fileSystemWith("one\ntwo\nthree\nfour\nfive\n"));

  assert.deepEqual(result, {
    content: [{
      type: "text",
      text: "Read recovered from notes.txt: requested offset 9 exceeded 5 lines. Showing lines 3-5.\n\nthree\nfour\nfive",
    }],
    details: {
      readOffsetContext: {
        path: "notes.txt",
        requestedOffset: 9,
        requestedLimit: 3,
        actualOffset: 3,
        returnedLines: 3,
        totalLines: 5,
        truncated: false,
      },
    },
    isError: false,
  });
});

test("recoverReadOffsetContext bounds large requested pages", async () => {
  const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);

  const result = await recoverReadOffsetContext({
    toolName: "read",
    input: { path: "large.txt", offset: 300, limit: 250 },
    isError: true,
    content: "Offset 300 is beyond end of file (250 lines total)",
  }, "/workspace", fileSystemWith(lines.join("\n")));

  const text = result?.content[0]?.text ?? "";
  assert.doesNotMatch(text, /line-50(?:\n|$)/);
  assert.match(text, /line-51/);
  assert.match(text, /line-250$/);
  assert.equal(Buffer.byteLength(text, "utf8") <= 5_000, true);
  assert.deepEqual(result?.details.readOffsetContext, {
    path: "large.txt",
    requestedOffset: 300,
    requestedLimit: 250,
    actualOffset: 51,
    returnedLines: 200,
    totalLines: 250,
    truncated: true,
  });
});

test("recoverReadOffsetContext bounds oversized lines by UTF-8 bytes", async () => {
  const result = await recoverReadOffsetContext({
    toolName: "read",
    input: { path: "wide.txt", offset: 3, limit: 2 },
    isError: true,
    content: "Offset 3 is beyond end of file (2 lines total)",
  }, "/workspace", fileSystemWith(`${"a".repeat(5_000)}\n${"😀".repeat(2_000)}`));

  const text = result?.content[0]?.text ?? "";
  assert.equal(Buffer.byteLength(text, "utf8") <= 5_000, true);
  assert.match(text, /…/);
  assert.doesNotMatch(text, /�/);
  assert.deepEqual(result?.details.readOffsetContext, {
    path: "wide.txt",
    requestedOffset: 3,
    requestedLimit: 2,
    actualOffset: 2,
    returnedLines: 1,
    totalLines: 2,
    truncated: true,
  });
});

test("recoverReadOffsetContext abstains when file changed after failed read", async () => {
  const result = await recoverReadOffsetContext({
    toolName: "read",
    input: { path: "notes.txt", offset: 9, limit: 3 },
    isError: true,
    content: "Offset 9 is beyond end of file (5 lines total)",
  }, "/workspace", fileSystemWith("one\ntwo\nthree\nfour\nfive\nsix"));

  assert.equal(result, undefined);
});

test("recoverReadOffsetContext ignores unrelated failures", async () => {
  const fileSystem = fileSystemWith("one\ntwo");

  assert.equal(await recoverReadOffsetContext({
    toolName: "bash",
    input: { path: "notes.txt", offset: 9, limit: 3 },
    isError: true,
    content: "Offset 9 is beyond end of file (5 lines total)",
  }, "/workspace", fileSystem), undefined);

  assert.equal(await recoverReadOffsetContext({
    toolName: "read",
    input: { path: "notes.txt", offset: 9, limit: 3 },
    isError: true,
    content: "permission denied",
  }, "/workspace", fileSystem), undefined);
});
