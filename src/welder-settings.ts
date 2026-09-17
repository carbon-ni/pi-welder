import { REPAIR_NAMES } from "./repair-names.ts";
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
  const repairRows: WelderSettingItem[] = REPAIR_NAMES.map((name) => ({
    id: `repair:${name}`,
    label: name,
    description: "Toggle this repair rule",
    currentValue: config.disabledRepairs.includes(name) ? "off" : "on",
    values: [...ON_OFF],
  }));
  return [
    {
      id: "repairsEnabled",
      label: "Repairs",
      description: "Structural repair of malformed tool arguments before tools run",
      currentValue: config.repairsEnabled ? "on" : "off",
      values: [...ON_OFF],
    },
    {
      id: "modelRepairReportingEnabled",
      label: "Per-model repair reporting",
      description: "Break mined repair stats down by model",
      currentValue: config.modelRepairReportingEnabled ? "on" : "off",
      values: [...ON_OFF],
    },
    {
      id: "sourceShadowingEnabled",
      label: "Jev source shadowing",
      description: "Send bounded redacted repository source to TypeSafe (leaves this machine)",
      currentValue: config.sourceShadowingEnabled ? "on" : "off",
      values: [...ON_OFF],
    },
    {
      id: "recoveryGuidanceLimit",
      label: "Failure history limit",
      description: "Max recent tool failures retained for explicit diagnostics",
      currentValue: String(config.recoveryGuidanceLimit),
      values: [...LIMIT_VALUES],
    },
    ...repairRows,
  ];
}

/** Apply one toggle selection back onto a config snapshot. Pure. */
export function applyWelderSetting(config: WelderConfig, id: string, value: string): WelderConfig {
  if (id.startsWith("repair:")) {
    const name = id.slice("repair:".length);
    if (!REPAIR_NAMES.includes(name)) return config;
    const disabled = new Set(config.disabledRepairs);
    if (value === "on") disabled.delete(name);
    else disabled.add(name);
    return { ...config, disabledRepairs: [...disabled] };
  }
  if (id === "repairsEnabled") {
    return { ...config, repairsEnabled: value === "on" };
  }
  if (id === "modelRepairReportingEnabled") {
    return { ...config, modelRepairReportingEnabled: value === "on" };
  }
  if (id === "sourceShadowingEnabled") {
    return { ...config, sourceShadowingEnabled: value === "on" };
  }
  if (id === "recoveryGuidanceLimit") {
    const limit = Number(value);
    if (Number.isInteger(limit) && limit >= 1 && limit <= 10) {
      return { ...config, recoveryGuidanceLimit: limit };
    }
  }
  return config;
}
