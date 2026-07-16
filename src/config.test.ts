import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWelderConfig, parseWelderConfig } from "./config.ts";

test("parseWelderConfig defaults optional model recovery off", () => {
  assert.deepEqual(parseWelderConfig({}, {}), {
    modelRepairReportingEnabled: false,
    modelRecovery: {
      enabled: false,
      model: "google/gemini-2.5-flash-lite",
      baseUrl: "https://openrouter.ai/api/v1",
      minConfidence: 0.9,
    },
  });
});

test("parseWelderConfig enables per-model repair reporting explicitly", () => {
  assert.equal(parseWelderConfig({ modelRepairReportingEnabled: true }).modelRepairReportingEnabled, true);
});

test("parseWelderConfig rejects truthy non-boolean values", () => {
  assert.equal(parseWelderConfig({ modelRepairReportingEnabled: "true" }).modelRepairReportingEnabled, false);
});

test("loadWelderConfig falls back safely when config cannot be read", () => {
  const config = loadWelderConfig("/missing/welder.json", () => { throw new Error("missing"); });
  assert.equal(config.modelRepairReportingEnabled, false);
  assert.equal(config.modelRecovery.enabled, false);
});

test("loadWelderConfig parses JSON from injected reader", () => {
  const config = loadWelderConfig("/agent/welder.json", () => '{"modelRepairReportingEnabled":true}');
  assert.equal(config.modelRepairReportingEnabled, true);
});

test("parseWelderConfig accepts explicit model recovery settings", () => {
  const config = parseWelderConfig({ modelRecovery: {
    enabled: true,
    apiKey: "key",
    model: "openai/gpt-4.1-nano",
    baseUrl: "https://router.test/api/v1",
    minConfidence: 0.95,
  } }, {});

  assert.deepEqual(config.modelRecovery, {
    enabled: true,
    apiKey: "key",
    model: "openai/gpt-4.1-nano",
    baseUrl: "https://router.test/api/v1",
    minConfidence: 0.95,
  });
});
