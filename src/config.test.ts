import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWelderConfig, parseWelderConfig, saveWelderConfig } from "./config.ts";

test("parseWelderConfig defaults model repair reporting off, limit to 3, repairs on, none disabled", () => {
  assert.deepEqual(parseWelderConfig({}), {
    modelRepairReportingEnabled: false,
    recoveryGuidanceLimit: 3,
    repairsEnabled: true,
    disabledRepairs: [],
    sourceShadowingEnabled: false,
    readPathRepairEnabled: false,
    commandReroutingEnabled: false, prospectiveLabelsEnabled: false,
  });
});

test("parseWelderConfig accepts a list of disabled repair names", () => {
  assert.deepEqual(parseWelderConfig({ disabledRepairs: ["parse-json", "directory-read"] }).disabledRepairs, [
    "parse-json",
    "directory-read",
  ]);
});

test("parseWelderConfig falls back to empty list for non-array or non-string entries", () => {
  assert.deepEqual(parseWelderConfig({ disabledRepairs: "parse-json" }).disabledRepairs, []);
  assert.deepEqual(parseWelderConfig({ disabledRepairs: ["parse-json", 42, null] }).disabledRepairs, ["parse-json"]);
});

test("parseWelderConfig disables repairs explicitly", () => {
  assert.equal(parseWelderConfig({ repairsEnabled: false }).repairsEnabled, false);
});

test("parseWelderConfig rejects falsy-looking non-boolean values for repairs", () => {
  assert.equal(parseWelderConfig({ repairsEnabled: "off" }).repairsEnabled, true);
  assert.equal(parseWelderConfig({ repairsEnabled: 0 }).repairsEnabled, true);
});

test("parseWelderConfig accepts an explicit recovery guidance limit in 1-10", () => {
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 7 }).recoveryGuidanceLimit, 7);
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 1 }).recoveryGuidanceLimit, 1);
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 10 }).recoveryGuidanceLimit, 10);
});

test("parseWelderConfig falls back to 3 for out-of-range or non-integer limits", () => {
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 0 }).recoveryGuidanceLimit, 3);
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 11 }).recoveryGuidanceLimit, 3);
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: 2.5 }).recoveryGuidanceLimit, 3);
  assert.equal(parseWelderConfig({ recoveryGuidanceLimit: "5" }).recoveryGuidanceLimit, 3);
});

test("parseWelderConfig enables per-model repair reporting explicitly", () => {
  assert.equal(parseWelderConfig({ modelRepairReportingEnabled: true }).modelRepairReportingEnabled, true);
});

test("parseWelderConfig requires an explicit boolean for source shadowing", () => {
  assert.equal(parseWelderConfig({ sourceShadowingEnabled: true, readPathRepairEnabled: false }).sourceShadowingEnabled, true);
  assert.equal(parseWelderConfig({ sourceShadowingEnabled: "on" }).sourceShadowingEnabled, false);
});

test("parseWelderConfig rejects truthy non-boolean values", () => {
  assert.equal(parseWelderConfig({ modelRepairReportingEnabled: "true" }).modelRepairReportingEnabled, false);
});

test("loadWelderConfig falls back safely when config cannot be read", () => {
  const config = loadWelderConfig("/missing/welder.json", () => { throw new Error("missing"); });
  assert.equal(config.modelRepairReportingEnabled, false);
});

test("loadWelderConfig parses JSON from injected reader", () => {
  const config = loadWelderConfig("/agent/welder.json", () => '{"modelRepairReportingEnabled":true}');
  assert.equal(config.modelRepairReportingEnabled, true);
});

test("saveWelderConfig writes JSON via injected writer", () => {
  let captured: { path: string; data: string } | null = null;
  saveWelderConfig(
    { modelRepairReportingEnabled: true, recoveryGuidanceLimit: 5, repairsEnabled: true, disabledRepairs: [], sourceShadowingEnabled: false, readPathRepairEnabled: false, commandReroutingEnabled: false, prospectiveLabelsEnabled: false },
    "/agent/welder.json",
    (path, data) => { captured = { path, data }; },
  );
  assert.equal(captured!.path, "/agent/welder.json");
  assert.deepEqual(JSON.parse(captured!.data), { modelRepairReportingEnabled: true, recoveryGuidanceLimit: 5, repairsEnabled: true, disabledRepairs: [], sourceShadowingEnabled: false, readPathRepairEnabled: false, commandReroutingEnabled: false, prospectiveLabelsEnabled: false });
});

test("saveWelderConfig serializes a disabled config", () => {
  let data = "";
  saveWelderConfig({ modelRepairReportingEnabled: false, recoveryGuidanceLimit: 3, repairsEnabled: false, disabledRepairs: [], sourceShadowingEnabled: false, readPathRepairEnabled: false, commandReroutingEnabled: false, prospectiveLabelsEnabled: false }, "/x", (_p, d) => { data = d; });
  assert.equal(JSON.parse(data).modelRepairReportingEnabled, false);
  assert.equal(JSON.parse(data).repairsEnabled, false);
});
