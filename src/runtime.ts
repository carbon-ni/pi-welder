import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";
import type { ModelRecoverySettings } from "./model-recovery/edit-mismatch.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  enabled: boolean;
  modelRepairReportingEnabled: boolean;
  modelRecovery: ModelRecoverySettings;
  modelRecoveryPreflightAttempts: Set<string>;
}

export interface RuntimeOptions {
  modelRepairReportingEnabled?: boolean;
  modelRecovery?: ModelRecoverySettings;
}

export function createRuntime(options: RuntimeOptions = {}): WelderRuntime {
  return {
    stats: createStats(),
    recovery: createRecoveryState(),
    repairWarnings: createRepairWarningState(),
    enabled: true,
    modelRepairReportingEnabled: options.modelRepairReportingEnabled ?? false,
    modelRecoveryPreflightAttempts: new Set(),
    modelRecovery: options.modelRecovery ?? {
      enabled: false,
      model: "google/gemini-2.5-flash-lite",
      baseUrl: "https://openrouter.ai/api/v1",
      minConfidence: 0.9,
    },
  };
}

export function resetSessionState(runtime: WelderRuntime): void {
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
  runtime.repairWarnings = createRepairWarningState();
  runtime.modelRecoveryPreflightAttempts.clear();
}
