import { test } from "node:test";
import assert from "node:assert/strict";

import { applyWelderSetting, welderSettingItems } from "./welder-settings.ts";
import type { WelderConfig } from "./config.ts";

const off: WelderConfig = { modelRepairReportingEnabled: false, recoveryGuidanceLimit: 3 };
const on: WelderConfig = { modelRepairReportingEnabled: true, recoveryGuidanceLimit: 3 };

test("welderSettingItems reflects current config values as on/off", () => {
  const items = welderSettingItems(off);
  assert.equal(items.length, 2);
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

test("welderSettingItems exposes the recovery guidance limit as 1-10", () => {
  const limit = welderSettingItems({ ...off, recoveryGuidanceLimit: 4 })
    .find((it) => it.id === "recoveryGuidanceLimit")!;
  assert.equal(limit.currentValue, "4");
  assert.deepEqual(limit.values, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
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
