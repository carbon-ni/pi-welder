import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { recoverEditMismatch } from "./edit-mismatch.ts";

const failure = "Could not find edits[0] in file.ts. The oldText must match exactly including all whitespace and newlines.";

test("recovers edit mismatch using model-located exact text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-recovery-"));
  await writeFile(path.join(root, "file.ts"), "const value = 1; // current\n");

  const result = await recoverEditMismatch({
    event: {
      toolName: "edit",
      input: { path: "file.ts", edits: [{ oldText: "const value=1;", newText: "const value = 2;" }] },
      isError: true,
      content: failure,
    },
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => ({ decision: "repair", confidence: 0.98, repairs: [{ index: 0, oldText: "const value = 1; // current" }] }),
  });

  assert.equal(result?.patch.isError, false);
  assert.match(String(result?.patch.content[0]?.text), /Recovered edit mismatch/);
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), "const value = 2;\n");
});

test("abstains when proposed oldText is ambiguous", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-recovery-"));
  await writeFile(path.join(root, "file.ts"), "same\nsame\n");

  const result = await recoverEditMismatch({
    event: { toolName: "edit", input: { path: "file.ts", edits: [{ oldText: "missing", newText: "next" }] }, isError: true, content: failure },
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => ({ decision: "repair", confidence: 0.99, repairs: [{ index: 0, oldText: "same" }] }),
  });

  assert.equal(result, undefined);
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), "same\nsame\n");
});

test("abstains when file changes while model is reasoning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-recovery-"));
  const target = path.join(root, "file.ts");
  await writeFile(target, "const value = 1;\n");

  const result = await recoverEditMismatch({
    event: { toolName: "edit", input: { path: "file.ts", edits: [{ oldText: "const value=1;", newText: "const value = 2;" }] }, isError: true, content: failure },
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => {
      await writeFile(target, "const value = 3;\n");
      return { decision: "repair", confidence: 0.99, repairs: [{ index: 0, oldText: "const value = 1;" }] };
    },
  });

  assert.equal(result, undefined);
  assert.equal(await readFile(target, "utf8"), "const value = 3;\n");
});

test("does not call model when recovery is disabled", async () => {
  let called = false;
  const result = await recoverEditMismatch({
    event: { toolName: "edit", input: {}, isError: true, content: failure },
    cwd: process.cwd(),
    settings: { enabled: false, model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => { called = true; return { decision: "abstain", confidence: 0, repairs: [] }; },
  });
  assert.equal(result, undefined);
  assert.equal(called, false);
});
