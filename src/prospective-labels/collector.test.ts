import { test } from "node:test";
import assert from "node:assert/strict";

import { createProspectiveLabelCollector, labelRecordIsPrivacySafe, renderLabelRecord } from "./collector.ts";
import { appendLine } from "./writer.ts";

const validation = (tool: string) => `Validation failed for tool "${tool}":\n  - path: must have required properties path\n\nReceived arguments:\n{ "execute": "SECRET" }`;

function collector(overrides: { enabled?: boolean } = {}) {
  const labels: any[] = [];
  const instance = createProspectiveLabelCollector({
    isEnabled: () => overrides.enabled ?? true,
    sessionId: () => "session-1",
    onLabel: (record) => labels.push(record),
  });
  return { instance, labels };
}

test("opens an episode only after an anchored Pi validation failure", () => {
  const { instance } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  assert.equal(instance.pendingCount(), 0, "no episode before confirmation");

  // A successful or non-anchored end never opens an episode.
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: false });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: "ENOENT" });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: 'Validation failed for tool "edit":' });
  assert.equal(instance.pendingCount(), 0);

  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.equal(instance.pendingCount(), 1, "episode opens on the matching anchored failure");
  assert.equal(instance.stats().validationFailures, 1);
});

test("labels a later exact plan match with unchanged values inside three calls", () => {
  const { instance, labels } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });

  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "git status", timeout: 30 } });
  const record = instance.onToolSuccess("bash", { command: "git status", timeout: 30 }, 1_000);

  assert.ok(record);
  assert.equal(record!.targetTool, "bash");
  assert.ok(record!.pairs.includes("command<-execute"));
  assert.equal(instance.pendingCount(), 0, "the episode is consumed");
  assert.equal(labels.length, 1);

  // A changed value never labels.
  instance.onToolStart({ toolCallId: "d1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "d1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "d2", toolName: "bash", args: { command: "git diff" } });
  assert.equal(instance.onToolSuccess("bash", { command: "git diff" }, 2_000), undefined);
  assert.equal(instance.pendingCount(), 1, "no label for a changed value");
});

test("excludes earlier parallel siblings and expires beyond the window", () => {
  const { instance } = collector();
  // Two calls start in the same batch; c1 fails validation, c2 (started before
  // confirmation) must never label c1's episode.
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.equal(instance.onToolSuccess("bash", { command: "git status" }, 1_000), undefined, "earlier sibling cannot label");

  // A later sibling that starts after confirmation labels normally.
  instance.onToolStart({ toolCallId: "c3", toolName: "bash", args: { command: "git status" } });
  assert.ok(instance.onToolSuccess("bash", { command: "git status" }, 2_000));

  // Beyond three following calls the episode expires.
  instance.onToolStart({ toolCallId: "e1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "e1", toolName: "write", isError: true, errorText: validation("write") });
  for (const id of ["f1", "f2", "f3", "f4"]) instance.onToolStart({ toolCallId: id, toolName: "read", args: { path: id } });
  assert.equal(instance.pendingCount(), 0, "expired outside the window");
  assert.equal(instance.onToolSuccess("bash", { command: "git status" }, 3_000), undefined);
});

test("stays inert when disabled, keeps memory bounded, and clears on cleanup", () => {
  const { instance } = collector({ enabled: false });
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "git status" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  assert.equal(instance.pendingCount(), 0, "disabled never opens an episode");
  assert.equal(instance.stats().observedCalls, 0);

  const bounded = collector();
  for (let index = 0; index < 30; index++) {
    const id = `p${index}`;
    bounded.instance.onToolStart({ toolCallId: id, toolName: "write", args: { execute: "git status" } });
    bounded.instance.onToolEnd({ toolCallId: id, toolName: "write", isError: true, errorText: validation("write") });
  }
  assert.ok(bounded.instance.pendingCount() <= 8, `bounded pending, got ${bounded.instance.pendingCount()}`);
  assert.ok(bounded.instance.stats().expired > 0, "eviction is counted");

  bounded.instance.clear();
  assert.equal(bounded.instance.pendingCount(), 0);
});

test("records are privacy-safe and the writer rejects oversized or multiline lines", async () => {
  const { instance, labels } = collector();
  instance.onToolStart({ toolCallId: "c1", toolName: "write", args: { execute: "SECRET_COMMAND --flag /Users/me/x" } });
  instance.onToolEnd({ toolCallId: "c1", toolName: "write", isError: true, errorText: validation("write") });
  instance.onToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "SECRET_COMMAND --flag /Users/me/x" } });
  instance.onToolSuccess("bash", { command: "SECRET_COMMAND --flag /Users/me/x" }, 1_000);

  const record = labels[0]!;
  const rendered = renderLabelRecord(record);
  for (const forbidden of ["SECRET_COMMAND", "--flag", "/Users/", "git status"]) {
    assert.equal(rendered.includes(forbidden), false, `record leaked ${forbidden}`);
  }
  assert.equal(labelRecordIsPrivacySafe(record), true);
  assert.equal(labelRecordIsPrivacySafe({ ...record, sourceTool: "bad tool!" }), false);

  const written: string[] = [];
  const mkdirImpl = async () => undefined;
  const appendImpl = async (_path: unknown, data: string) => { written.push(data); };
  await appendLine("/tmp/x", "s.labels.jsonl", rendered, { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  assert.equal(written.length, 1);
  await appendLine("/tmp/x", "s.labels.jsonl", "x".repeat(5_000), { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  await appendLine("/tmp/x", "s.labels.jsonl", "two\nlines", { mkdirImpl: mkdirImpl as never, appendImpl: appendImpl as never });
  assert.equal(written.length, 1, "oversized and multiline lines are rejected");
});
