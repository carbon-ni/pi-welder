import { test } from "node:test";
import assert from "node:assert/strict";

import { createRuntime, resetSessionState } from "./runtime.ts";

test("createRuntime starts enabled with fresh stats and recovery", () => {
  const runtime = createRuntime();

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.modelRepairReportingEnabled, false);
  assert.equal(runtime.stats.totalToolCalls, 0);
  assert.equal(runtime.recovery.failures.length, 0);
  assert.equal(runtime.recovery.maxFailures, 3);
});

test("createRuntime accepts per-model repair reporting feature flag", () => {
  assert.equal(createRuntime({ modelRepairReportingEnabled: true }).modelRepairReportingEnabled, true);
});

test("createRuntime honors a configured recovery guidance limit", () => {
  assert.equal(createRuntime({ recoveryGuidanceLimit: 6 }).recovery.maxFailures, 6);
});

test("resetSessionState resets stats and recovery while preserving guidance limit", () => {
  const runtime = createRuntime();
  runtime.enabled = false;
  runtime.stats.totalToolCalls = 3;
  runtime.recovery.maxFailures = 7;
  runtime.recovery.failures.push({
    toolName: "edit",
    inputKeys: ["path"],
    errorText: "failed",
    ts: "2026-07-05T00:00:00.000Z",
  });

  resetSessionState(runtime);

  assert.equal(runtime.enabled, false);
  assert.equal(runtime.stats.totalToolCalls, 0);
  assert.equal(runtime.recovery.maxFailures, 7);
  assert.equal(runtime.recovery.failures.length, 0);
});
