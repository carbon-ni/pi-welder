import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WelderConfig {
  modelRepairReportingEnabled: boolean;
  recoveryGuidanceLimit: number;
}

export const WELDER_CONFIG_PATH = join(homedir(), ".pi", "agent", "welder.json");

const DEFAULT_RECOVERY_GUIDANCE_LIMIT = 3;

function parseRecoveryGuidanceLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    return DEFAULT_RECOVERY_GUIDANCE_LIMIT;
  }
  return raw;
}

export function parseWelderConfig(value: unknown): WelderConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    modelRepairReportingEnabled: input.modelRepairReportingEnabled === true,
    recoveryGuidanceLimit: parseRecoveryGuidanceLimit(input.recoveryGuidanceLimit),
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
