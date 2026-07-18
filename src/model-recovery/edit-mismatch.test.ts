import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preflightEditMismatch, recoverEditMismatch } from "./edit-mismatch.ts";

const failure = "Could not find the exact text in file.ts. The old text must match exactly including all whitespace and newlines.";

test("preflight repairs oldText before built-in edit executes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-preflight-"));
  await writeFile(path.join(root, "file.ts"), "const value = 1; // current\n");
  const toolInput = { path: "file.ts", edits: [{ oldText: "const value=1;", newText: "const value = 2;" }] };

  const result = await preflightEditMismatch({
    toolInput,
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => ({ decision: "repair", confidence: 0.98, repairs: [{ oldText: "const value = 1; // current" }] }),
  });

  assert.equal(result?.repairedEdits, 1);
  assert.equal(toolInput.edits[0]?.oldText, "const value = 1; // current");
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), "const value = 1; // current\n");
});

test("repairs an ambiguous edit locally when another batch edit excludes one occurrence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-ambiguity-"));
  const current = [
    "interface First {",
    "  fileBytes?: number;",
    "}",
    "",
    "interface Second {",
    "  fileBytes?: number;",
    "}",
    "",
    "interface AfterSecond {}",
    "",
  ].join("\n");
  await writeFile(path.join(root, "file.ts"), current);
  const ambiguousOldText = "  fileBytes?: number;\n}";
  const ambiguousNewText = "  fileBytes?: number;\n  candidateCount?: number;\n}";
  const toolInput = { path: "file.ts", edits: [
    { oldText: ambiguousOldText, newText: ambiguousNewText },
    { oldText: "  fileBytes?: number;\n}\n\ninterface AfterSecond", newText: "  fileBytes?: number;\n  candidateCount?: number;\n}\n\ninterface AfterSecond" },
  ] };

  const result = await preflightEditMismatch({
    toolInput,
    cwd: root,
    settings: { enabled: true, model: "cheap/model", baseUrl: "https://openrouter.test", minConfidence: 0.9 },
    callModel: async () => { throw new Error("model must not be called"); },
  });

  assert.equal(result?.repairedEdits, 1);
  const repaired = toolInput.edits[0]!;
  assert.equal(current.split(repaired.oldText).length - 1, 1);
  const oldTextOffset = repaired.oldText.indexOf(ambiguousOldText);
  assert.notEqual(oldTextOffset, -1);
  const prefix = repaired.oldText.slice(0, oldTextOffset);
  const suffix = repaired.oldText.slice(oldTextOffset + ambiguousOldText.length);
  assert.equal(repaired.newText, prefix + ambiguousNewText + suffix);
  const locallyApplied = current.replace(repaired.oldText, repaired.newText);
  assert.match(locallyApplied, /interface First \{\n  fileBytes\?: number;\n  candidateCount\?: number;/);
  assert.match(locallyApplied, /interface Second \{\n  fileBytes\?: number;\n\}/);
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), current);
});

test("abstains locally when an ambiguous edit still has multiple viable occurrences", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-ambiguity-"));
  const current = "function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n";
  await writeFile(path.join(root, "file.ts"), current);
  const toolInput = { path: "file.ts", edits: [{ oldText: "  return 1;", newText: "  return 2;" }] };
  let modelCalled = false;

  const result = await preflightEditMismatch({
    toolInput,
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test", minConfidence: 0.9 },
    callModel: async () => { modelCalled = true; return { decision: "repair", confidence: 1, repairs: [{ oldText: "  return 1;" }] }; },
  });

  assert.equal(result, undefined);
  assert.equal(modelCalled, false);
  assert.deepEqual(toolInput.edits, [{ oldText: "  return 1;", newText: "  return 2;" }]);
});

test("maps ordered model candidates to unresolved edits without model-owned indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-positional-"));
  await writeFile(path.join(root, "file.ts"), "const stable = 1;\nconst current = 2;\n");
  const toolInput = { path: "file.ts", edits: [
    { oldText: "const stable = 1;", newText: "const stable = 3;" },
    { oldText: "const stale=2;", newText: "const current = 4;" },
  ] };

  let modelPrompt = "";
  await preflightEditMismatch({
    toolInput, cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test", minConfidence: 0.9 },
    callModel: async (request) => {
      modelPrompt = request.prompt;
      return { decision: "repair", confidence: 1, repairs: [{ oldText: "const current = 2;" }] };
    },
  });

  assert.doesNotMatch(modelPrompt, /"index"/);
  assert.match(modelPrompt, /same number and order/);
  assert.match(modelPrompt, /verbatim substring/);
  assert.equal(toolInput.edits[0]?.oldText, "const stable = 1;");
  assert.equal(toolInput.edits[1]?.oldText, "const current = 2;");
});

test("recovers edit mismatch using model-located exact text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-recovery-"));
  await writeFile(path.join(root, "file.ts"), "const value = 1; // current\n");

  const observations: string[] = [];
  const result = await recoverEditMismatch({
    onObservation: async (event) => { observations.push(`${event.stage}:${event.outcome}`); },
    event: {
      toolName: "edit",
      input: { path: "file.ts", edits: [{ oldText: "const value=1;", newText: "const value = 2;" }] },
      isError: true,
      content: failure,
    },
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => ({ decision: "repair", confidence: 0.98, repairs: [{ oldText: "const value = 1; // current" }] }),
  });

  assert.equal(result?.patch.isError, false);
  assert.match(String(result?.patch.content[0]?.text), /Recovered edit mismatch/);
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), "const value = 2;\n");
  assert.deepEqual(observations, ["detected:attempting", "requested:pending", "decided:repair", "validated:accepted", "applied:success"]);
});

test("abstains when proposed oldText is ambiguous", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-model-recovery-"));
  await writeFile(path.join(root, "file.ts"), "same\nsame\n");

  const result = await recoverEditMismatch({
    event: { toolName: "edit", input: { path: "file.ts", edits: [{ oldText: "missing", newText: "next" }] }, isError: true, content: failure },
    cwd: root,
    settings: { enabled: true, apiKey: "key", model: "cheap/model", baseUrl: "https://openrouter.test/api/v1", minConfidence: 0.9 },
    callModel: async () => ({ decision: "repair", confidence: 0.99, repairs: [{ oldText: "same" }] }),
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
      return { decision: "repair", confidence: 0.99, repairs: [{ oldText: "const value = 1;" }] };
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
