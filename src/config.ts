import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WelderConfig {
  modelRepairReportingEnabled: boolean;
  recoveryGuidanceLimit: number;
  repairsEnabled: boolean;
  disabledRepairs: string[];
  sourceShadowingEnabled: boolean;
  /**
   * TASK-0022 opt-in: repair missing read paths via bounded Jev ranking.
   * Default OFF and independent of source-shadow consent; runtime mutation
   * additionally requires the predeclared evidence gate to pass.
   */
  readPathRepairEnabled: boolean;
  /**
   * TASK-0034 opt-in: execute an exact bash-shaped call addressed to
   * `read`/`write`/`edit` once through Pi's built-in bash tool. Default OFF.
   * Requires repair routing enabled, an explicit trusted project, and an
   * injected bash capability; every other condition fails closed.
   */
  commandReroutingEnabled: boolean;
  /**
   * TASK-0037 opt-in: collect prospective routing labels locally by observing
   * the tool lifecycle. Default OFF. Never calls a model or executes anything.
   */
  prospectiveLabelsEnabled: boolean;
}

export const WELDER_CONFIG_PATH = join(homedir(), ".pi", "agent", "welder.json");

const DEFAULT_RECOVERY_GUIDANCE_LIMIT = 3;

function parseRecoveryGuidanceLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    return DEFAULT_RECOVERY_GUIDANCE_LIMIT;
  }
  return raw;
}

function parseDisabledRepairs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === "string");
}

export function parseWelderConfig(value: unknown): WelderConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    modelRepairReportingEnabled: input.modelRepairReportingEnabled === true,
    recoveryGuidanceLimit: parseRecoveryGuidanceLimit(input.recoveryGuidanceLimit),
    repairsEnabled: input.repairsEnabled !== false,
    disabledRepairs: parseDisabledRepairs(input.disabledRepairs),
    sourceShadowingEnabled: input.sourceShadowingEnabled === true,
    readPathRepairEnabled: input.readPathRepairEnabled === true,
    commandReroutingEnabled: input.commandReroutingEnabled === true,
    prospectiveLabelsEnabled: input.prospectiveLabelsEnabled === true,
  };
}

export function loadWelderConfig(
  path = WELDER_CONFIG_PATH,
  read: (path: string, encoding: BufferEncoding) => string = readFileSync,
): WelderConfig {
  try {
    return parseWelderConfig(JSON.parse(read(path, "utf8")));
  } catch {
    return parseWelderConfig({});
  }
}

export function saveWelderConfig(
  config: WelderConfig,
  path = WELDER_CONFIG_PATH,
  write: (path: string, data: string) => void = writeFileSync,
): void {
  write(path, JSON.stringify(config, null, 2));
}
