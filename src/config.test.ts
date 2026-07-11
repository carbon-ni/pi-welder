import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWelderConfig, parseWelderConfig } from "./config.ts";

test("parseWelderConfig defaults per-model repair reporting off", () => {
  assert.deepEqual(parseWelderConfig({}), { modelRepairReportingEnabled: false });
});

test("parseWelderConfig enables per-model repair reporting explicitly", () => {
  assert.deepEqual(parseWelderConfig({ modelRepairReportingEnabled: true }), {
    modelRepairReportingEnabled: true,
  });
});

test("parseWelderConfig rejects truthy non-boolean values", () => {
  assert.deepEqual(parseWelderConfig({ modelRepairReportingEnabled: "true" }), {
    modelRepairReportingEnabled: false,
  });
});

test("loadWelderConfig falls back safely when config cannot be read", () => {
  const config = loadWelderConfig("/missing/welder.json", () => { throw new Error("missing"); });
  assert.deepEqual(config, { modelRepairReportingEnabled: false });
});

test("loadWelderConfig parses JSON from injected reader", () => {
  const config = loadWelderConfig("/agent/welder.json", () => '{"modelRepairReportingEnabled":true}');
  assert.deepEqual(config, { modelRepairReportingEnabled: true });
});
