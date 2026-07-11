import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  enabled: boolean;
  modelRepairReportingEnabled: boolean;
}

export interface RuntimeOptions {
  modelRepairReportingEnabled?: boolean;
}

export function createRuntime(options: RuntimeOptions = {}): WelderRuntime {
  return {
    stats: createStats(),
    recovery: createRecoveryState(),
    repairWarnings: createRepairWarningState(),
    enabled: true,
    modelRepairReportingEnabled: options.modelRepairReportingEnabled ?? false,
  };
}

export function resetSessionState(runtime: WelderRuntime): void {
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
  runtime.repairWarnings = createRepairWarningState();
}
