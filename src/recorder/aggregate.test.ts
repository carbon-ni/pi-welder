import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateFailures,
  aggregateRepairs,
  type FailureCluster,
} from "./aggregate.ts";
import { buildToolResultEvent } from "./events.ts";
import type { WelderEvent } from "./events.ts";

function failureEvent(toolName: string, errorText: string, inputKeys: string[] = []): WelderEvent {
  return buildToolResultEvent({ toolName, provider: "p", model: "m", inputKeys, errorText });
}

// ─── aggregation ────────────────────────────────────────────────────────

test("aggregateFailures returns empty for no events", () => {
  assert.deepEqual(aggregateFailures([]), []);
});

test("aggregateFailures ignores non-error events", () => {
  const ok: WelderEvent = {
    ts: "t",
    eventType: "tool_call",
    toolName: "edit",
    provider: "p",
    model: "m",
    repairs: [],
    wasRepaired: false,
    inputKeys: [],
  };
  assert.deepEqual(aggregateFailures([ok]), []);
});

test("aggregateFailures groups by (toolName, errorKind)", () => {
  const events = [
    failureEvent("read", "ENOENT no such file", ["path"]),
    failureEvent("read", "ENOENT another missing", ["path"]),
    failureEvent("edit", "EDIT_MISMATCH oldText not found", ["path", "edits"]),
  ];
  const clusters = aggregateFailures(events);
  assert.equal(clusters.length, 2);

  const reads = clusters.find((c) => c.toolName === "read")!;
  assert.equal(reads.errorKind, "ENOENT");
  assert.equal(reads.count, 2);

  const edits = clusters.find((c) => c.toolName === "edit")!;
  assert.equal(edits.errorKind, "EDIT_MISMATCH");
  assert.equal(edits.count, 1);
});

test("aggregateFailures sorts clusters by count desc, then toolName", () => {
  const events = [
    failureEvent("edit", "EDIT_MISMATCH x"),
    failureEvent("read", "ENOENT a"),
    failureEvent("read", "ENOENT b"),
    failureEvent("read", "ENOENT c"),
  ];
  const clusters = aggregateFailures(events);
  assert.equal(clusters[0]!.toolName, "read");
  assert.equal(clusters[0]!.count, 3);
  assert.equal(clusters[1]!.toolName, "edit");
  assert.equal(clusters[1]!.count, 1);
});

test("aggregateFailures keeps up to N samples per cluster, newest last", () => {
  const events = [
    failureEvent("read", "ENOENT first"),
    failureEvent("read", "ENOENT second"),
    failureEvent("read", "ENOENT third"),
    failureEvent("read", "ENOENT fourth"),
  ];
  const clusters = aggregateFailures(events, { maxSamples: 2 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.count, 4);
  assert.equal(clusters[0]!.samples.length, 2);
  // Most recent samples kept
  assert.match(clusters[0]!.samples[0]!.errorText, /third|fourth/);
  assert.match(clusters[0]!.samples[1]!.errorText, /third|fourth/);
});

test("aggregateFailures samples carry inputKeys", () => {
  const events = [failureEvent("edit", "EDIT_MISMATCH x", ["path", "edits"])];
  const clusters = aggregateFailures(events);
  assert.deepEqual(clusters[0]!.samples[0]!.inputKeys, ["path", "edits"]);
});

test("aggregateFailures dedupes identical errorText within a cluster", () => {
  const events = [
    failureEvent("read", "ENOENT same"),
    failureEvent("read", "ENOENT same"),
    failureEvent("read", "ENOENT same"),
  ];
  const clusters = aggregateFailures(events);
  assert.equal(clusters[0]!.count, 3);
  assert.equal(clusters[0]!.samples.length, 1);
  assert.equal(clusters[0]!.samples[0]!.errorText, "ENOENT same");
});

test("aggregateFailures groups unknown error kinds under TOOL_ERROR", () => {
  const events = [failureEvent("bash", "something weird happened")];
  const clusters = aggregateFailures(events);
  assert.equal(clusters[0]!.errorKind, "TOOL_ERROR");
});

test("aggregateRepairs ranks repair actions by provider, model, and tool", () => {
  const events: WelderEvent[] = [
    { ts: "1", eventType: "tool_call", toolName: "edit", provider: "anthropic", model: "opus", repairs: ["strip-extra-props"], wasRepaired: true, inputKeys: ["edits"] },
    { ts: "2", eventType: "tool_call", toolName: "edit", provider: "anthropic", model: "opus", repairs: ["strip-extra-props", "array-shape"], wasRepaired: true, inputKeys: ["edits"] },
    { ts: "3", eventType: "tool_call", toolName: "edit", provider: "openai", model: "gpt", repairs: ["strip-extra-props"], wasRepaired: true, inputKeys: ["edits"] },
  ];

  assert.deepEqual(aggregateRepairs(events), [
    { provider: "anthropic", model: "opus", toolName: "edit", action: "strip-extra-props", count: 2 },
    { provider: "anthropic", model: "opus", toolName: "edit", action: "array-shape", count: 1 },
    { provider: "openai", model: "gpt", toolName: "edit", action: "strip-extra-props", count: 1 },
  ]);
});
