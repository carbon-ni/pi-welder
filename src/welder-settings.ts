import type { WelderConfig } from "./config.ts";

/**
 * A single toggle row. Shape mirrors pi-tui's SettingItem so items pass
 * straight through to SettingsList without mapping.
 */
export interface WelderSettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values: string[];
}

const ON_OFF = ["on", "off"] as const;
const LIMIT_VALUES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;

/** Build the editable setting rows for the /welder-settings list. Pure. */
export function welderSettingItems(config: WelderConfig): WelderSettingItem[] {
  return [
    {
      id: "modelRepairReportingEnabled",
      label: "Per-model repair reporting",
      description: "Break mined repair stats down by model",
      currentValue: config.modelRepairReportingEnabled ? "on" : "off",
      values: [...ON_OFF],
    },
    {
      id: "recoveryGuidanceLimit",
      label: "Recovery guidance limit",
      description: "Max recent tool failures included in recovery hints",
      currentValue: String(config.recoveryGuidanceLimit),
      values: [...LIMIT_VALUES],
    },
  ];
}

/** Apply one toggle selection back onto a config snapshot. Pure. */
export function applyWelderSetting(config: WelderConfig, id: string, value: string): WelderConfig {
  if (id === "modelRepairReportingEnabled") {
    return { ...config, modelRepairReportingEnabled: value === "on" };
  }
  if (id === "recoveryGuidanceLimit") {
    const limit = Number(value);
    if (Number.isInteger(limit) && limit >= 1 && limit <= 10) {
      return { ...config, recoveryGuidanceLimit: limit };
    }
  }
  return config;
}
