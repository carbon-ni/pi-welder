import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRecoverySettings } from "./model-recovery/edit-mismatch.ts";

export interface WelderConfig {
  modelRepairReportingEnabled: boolean;
  modelRecovery: ModelRecoverySettings;
}

export const WELDER_CONFIG_PATH = join(homedir(), ".pi", "agent", "welder.json");
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function parseWelderConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): WelderConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawRecovery = input.modelRecovery && typeof input.modelRecovery === "object"
    ? input.modelRecovery as Record<string, unknown>
    : {};
  const confidence = typeof rawRecovery.minConfidence === "number" && rawRecovery.minConfidence >= 0 && rawRecovery.minConfidence <= 1
    ? rawRecovery.minConfidence
    : 0.9;
  return {
    modelRepairReportingEnabled: input.modelRepairReportingEnabled === true,
    modelRecovery: {
      enabled: rawRecovery.enabled === true,
      ...(env.OPENROUTER_API_KEY || optionalString(rawRecovery.apiKey)
        ? { apiKey: env.OPENROUTER_API_KEY || optionalString(rawRecovery.apiKey) }
        : {}),
      model: env.OPENROUTER_WELDER_MODEL || optionalString(rawRecovery.model) || DEFAULT_MODEL,
      baseUrl: env.OPENROUTER_BASE_URL || optionalString(rawRecovery.baseUrl) || DEFAULT_BASE_URL,
      minConfidence: confidence,
    },
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
