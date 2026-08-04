import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preflightEditMismatch } from "./edit-mismatch.ts";

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

  const result = await preflightEditMismatch({
    toolInput,
    cwd: root,
  });

  assert.equal(result, undefined);
  assert.deepEqual(toolInput.edits, [{ oldText: "  return 1;", newText: "  return 2;" }]);
});

test("repairs a zero-occurrence oldText via a unique whitespace-normalized match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-missing-"));
  const current = "const value = 1; // current\n";
  await writeFile(path.join(root, "file.ts"), current);
  const toolInput = { path: "file.ts", edits: [{ oldText: "const value=1;", newText: "const value = 2;" }] };

  const result = await preflightEditMismatch({
    toolInput,
    cwd: root,
  });

  assert.equal(result?.repairedEdits, 1);
  // oldText becomes the verbatim file text; newText stays byte-identical.
  assert.equal(toolInput.edits[0]?.oldText, "const value = 1;");
  assert.equal(toolInput.edits[0]?.newText, "const value = 2;");
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), current);
});

test("repairs zero-occurrence oldText with indentation drift via normalized match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-missing-"));
  const current = [
    "function render() {",
    "    return uniqToken + suffix;",
    "}",
  ].join("\n");
  await writeFile(path.join(root, "file.ts"), current);
  const toolInput = { path: "file.ts", edits: [{ oldText: "\treturn uniqToken  +  suffix;", newText: "  return other;" }] };

  const result = await preflightEditMismatch({ toolInput, cwd: root });

  assert.equal(result?.repairedEdits, 1);
  assert.equal(toolInput.edits[0]?.oldText, "return uniqToken + suffix;");
  assert.equal(toolInput.edits[0]?.newText, "  return other;");
});

test("abstains when the whitespace-normalized match is not unique", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-missing-"));
  const current = "if (a) {\n  return 1;\n}\nif (b) {\n    return 1;\n}\n";
  await writeFile(path.join(root, "file.ts"), current);
  const toolInput = { path: "file.ts", edits: [{ oldText: "return  1;", newText: "return 2;" }] };

  const result = await preflightEditMismatch({ toolInput, cwd: root });

  assert.equal(result, undefined);
  assert.equal(toolInput.edits[0]?.oldText, "return  1;");
});

test("abstains when oldText is truly absent (no normalized match)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-local-missing-"));
  const current = "const value = 1; // current\n";
  await writeFile(path.join(root, "file.ts"), current);
  const toolInput = { path: "file.ts", edits: [{ oldText: "let somethingElse = true;", newText: "let somethingElse = false;" }] };

  const result = await preflightEditMismatch({ toolInput, cwd: root });

  assert.equal(result, undefined);
  assert.equal(toolInput.edits[0]?.oldText, "let somethingElse = true;");
  assert.equal(await readFile(path.join(root, "file.ts"), "utf8"), current);
});
