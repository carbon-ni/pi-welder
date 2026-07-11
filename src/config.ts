import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WelderConfig {
  modelRepairReportingEnabled: boolean;
}

export const WELDER_CONFIG_PATH = join(homedir(), ".pi", "agent", "welder.json");

export function parseWelderConfig(value: unknown): WelderConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    modelRepairReportingEnabled: input.modelRepairReportingEnabled === true,
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
