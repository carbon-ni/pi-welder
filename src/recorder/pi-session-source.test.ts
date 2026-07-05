import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { extractPiFailures, loadPiSessionEvents, readPiSessionFile } from "./pi-session-source.ts";

/** Build a minimal Pi session JSONL string from a sequence of records. */
function sessionJsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
    },
  };
}

function result(id: string, toolName: string, text: string, isError: boolean) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName,
      isError,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "welder-pi-"));

// ─── extractPiFailures (pure) ───────────────────────────────────────────

test("extractPiFailures returns [] for empty records", () => {
  assert.deepEqual(extractPiFailures([]), []);
});

test("extractPiFailures ignores non-error tool results", () => {
  const records = [
    call("c1", "read", { path: "a.ts" }),
    result("c1", "read", "file contents", false),
  ];
  assert.deepEqual(extractPiFailures(records), []);
});

test("extractPiFailures ignores records that are not messages", () => {
  const records = [
    { type: "session", cwd: "/x" },
    { type: "model_change" },
  ];
  assert.deepEqual(extractPiFailures(records), []);
});

test("extractPiFailures extracts an error joined to its toolCall", () => {
  const records = [
    call("c1", "read", { path: "a.ts", limit: 10 }),
    result("c1", "read", "ENOENT: no such file", true),
  ];
  const failures = extractPiFailures(records);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.toolName, "read");
  assert.equal(failures[0]!.wasError, true);
  assert.equal(failures[0]!.errorKind, "ENOENT");
  assert.match(failures[0]!.errorText ?? "", /ENOENT/);
  assert.deepEqual(failures[0]!.inputKeys, ["path", "limit"]);
});

test("extractPiFailures uses toolResult.toolName when toolCall missing", () => {
  const records = [result("orphan", "edit", "oldText not found", true)];
  const failures = extractPiFailures(records);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.toolName, "edit");
  assert.deepEqual(failures[0]!.inputKeys, []);
});

test("extractPiFailures handles missing content array", () => {
  const records = [
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true },
    },
  ];
  const failures = extractPiFailures(records);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.errorText, "");
});

test("extractPiFailures classifies error kind from raw text", () => {
  const records = [result("c1", "edit", "EDIT_MISMATCH: oldText not found", true)];
  const failures = extractPiFailures(records);
  assert.equal(failures[0]!.errorKind, "EDIT_MISMATCH");
});

// ─── readPiSessionFile (I/O) ────────────────────────────────────────────

test("readPiSessionFile parses a JSONL file into failures", async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, sessionJsonl([
      call("c1", "read", { path: "a.ts" }),
      result("c1", "read", "ENOENT: no such file", true),
    ]));
    const failures = await readPiSessionFile(file);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.toolName, "read");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readPiSessionFile tolerates blank and malformed lines", async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, "\nnot-json\n" + sessionJsonl([
      result("c1", "bash", "command failed", true),
    ]));
    const failures = await readPiSessionFile(file);
    assert.equal(failures.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readPiSessionFile on missing file returns []", async () => {
  const failures = await readPiSessionFile(path.join(os.tmpdir(), "nope-" + Date.now() + ".jsonl"));
  assert.deepEqual(failures, []);
});

// ─── loadPiSessionEvents (dir scan) ─────────────────────────────────────

test("loadPiSessionEvents reads .jsonl across nested workspace dirs", async () => {
  const root = await tmp();
  try {
    const wsA = path.join(root, "--workspace-a--");
    const wsB = path.join(root, "--workspace-b--");
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });
    await fs.writeFile(path.join(wsA, "s1.jsonl"), sessionJsonl([
      result("c1", "read", "ENOENT", true),
    ]));
    await fs.writeFile(path.join(wsB, "s2.jsonl"), sessionJsonl([
      result("c2", "edit", "EDIT_MISMATCH", true),
    ]));
    await fs.writeFile(path.join(wsA, "notes.txt"), "ignored");

    const failures = await loadPiSessionEvents(root);
    assert.equal(failures.length, 2);
    const tools = failures.map((f) => f.toolName).sort();
    assert.deepEqual(tools, ["edit", "read"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadPiSessionEvents on a missing dir returns []", async () => {
  const failures = await loadPiSessionEvents(path.join(os.tmpdir(), "nope-" + Date.now()));
  assert.deepEqual(failures, []);
});
