import { test } from "node:test";
import assert from "node:assert/strict";

import { applyWelderSetting, welderSettingItems } from "./welder-settings.ts";
import { REPAIR_NAMES } from "./repair-names.ts";
import type { WelderConfig } from "./config.ts";

const off: WelderConfig = { modelRepairReportingEnabled: false, recoveryGuidanceLimit: 3, repairsEnabled: true, disabledRepairs: [], sourceShadowingEnabled: false, readPathRepairEnabled: false };
const on: WelderConfig = { modelRepairReportingEnabled: true, recoveryGuidanceLimit: 3, repairsEnabled: true, disabledRepairs: [], sourceShadowingEnabled: false, readPathRepairEnabled: false };

test("welderSettingItems reflects current config values as on/off", () => {
  const items = welderSettingItems(off);
  assert.equal(items.length, 5 + REPAIR_NAMES.length);
  const reporting = items.find((it) => it.id === "modelRepairReportingEnabled")!;
  assert.equal(reporting.currentValue, "off");
  assert.deepEqual(reporting.values, ["on", "off"]);
  assert.ok(reporting.label.length > 0, "item has a label");
});

test("welderSettingItems shows on when flag enabled", () => {
  assert.equal(
    welderSettingItems(on).find((it) => it.id === "modelRepairReportingEnabled")!.currentValue,
    "on",
  );
});

test("welderSettingItems explains source leaves the machine", () => {
  const item = welderSettingItems({ ...off, sourceShadowingEnabled: true, readPathRepairEnabled: false }).find((it) => it.id === "sourceShadowingEnabled")!;
  assert.equal(item.currentValue, "on");
  assert.match(item.description ?? "", /leaves this machine/);
});

test("welderSettingItems exposes the recovery guidance limit as 1-10", () => {
  const limit = welderSettingItems({ ...off, recoveryGuidanceLimit: 4 })
    .find((it) => it.id === "recoveryGuidanceLimit")!;
  assert.equal(limit.currentValue, "4");
  assert.deepEqual(limit.values, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
});

test("welderSettingItems exposes the repairs toggle", () => {
  const items = welderSettingItems({ ...off, repairsEnabled: false });
  const repairs = items.find((it) => it.id === "repairsEnabled")!;
  assert.equal(repairs.currentValue, "off");
  assert.deepEqual(repairs.values, ["on", "off"]);
  assert.ok(repairs.label.length > 0, "item has a label");
});

test("applyWelderSetting toggles model repair reporting on", () => {
  const updated = applyWelderSetting(off, "modelRepairReportingEnabled", "on");
  assert.equal(updated.modelRepairReportingEnabled, true);
  assert.equal(updated.recoveryGuidanceLimit, 3);
});

test("applyWelderSetting toggles model repair reporting off", () => {
  const updated = applyWelderSetting(on, "modelRepairReportingEnabled", "off");
  assert.equal(updated.modelRepairReportingEnabled, false);
});

test("applyWelderSetting toggles source shadowing", () => {
  assert.equal(applyWelderSetting(off, "sourceShadowingEnabled", "on").sourceShadowingEnabled, true);
  assert.equal(applyWelderSetting({ ...off, sourceShadowingEnabled: true, readPathRepairEnabled: false }, "sourceShadowingEnabled", "off").sourceShadowingEnabled, false);
});

test("applyWelderSetting toggles repairs off and on", () => {
  assert.equal(applyWelderSetting(off, "repairsEnabled", "off").repairsEnabled, false);
  assert.equal(applyWelderSetting({ ...off, repairsEnabled: false }, "repairsEnabled", "on").repairsEnabled, true);
});

test("welderSettingItems exposes one on/off row per repair name", () => {
  const config: WelderConfig = { ...off, disabledRepairs: ["parse-json"] };
  const items = welderSettingItems(config);
  const repairItems = items.filter((it) => it.id.startsWith("repair:"));
  assert.equal(repairItems.length, REPAIR_NAMES.length);
  const parseJson = repairItems.find((it) => it.id === "repair:parse-json")!;
  assert.equal(parseJson.currentValue, "off");
  const stripNull = repairItems.find((it) => it.id === "repair:strip-null")!;
  assert.equal(stripNull.currentValue, "on");
  assert.deepEqual(stripNull.values, ["on", "off"]);
});

test("applyWelderSetting disables a repair by name", () => {
  const updated = applyWelderSetting(off, "repair:parse-json", "off");
  assert.deepEqual(updated.disabledRepairs, ["parse-json"]);
});

test("applyWelderSetting re-enables a disabled repair", () => {
  const config: WelderConfig = { ...off, disabledRepairs: ["parse-json", "directory-read"] };
  const updated = applyWelderSetting(config, "repair:parse-json", "on");
  assert.deepEqual(updated.disabledRepairs, ["directory-read"]);
});

test("applyWelderSetting returns config unchanged for unknown setting id", () => {
  assert.deepEqual(applyWelderSetting(on, "does-not-exist", "on"), on);
});

test("applyWelderSetting updates the recovery guidance limit", () => {
  assert.equal(applyWelderSetting(off, "recoveryGuidanceLimit", "7").recoveryGuidanceLimit, 7);
});

test("applyWelderSetting ignores out-of-range limit values", () => {
  assert.equal(applyWelderSetting(off, "recoveryGuidanceLimit", "0").recoveryGuidanceLimit, 3);
  assert.equal(applyWelderSetting(off, "recoveryGuidanceLimit", "99").recoveryGuidanceLimit, 3);
});
