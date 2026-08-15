import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  enabled: boolean;
  disabledRepairs: ReadonlySet<string>;
  modelRepairReportingEnabled: boolean;
}

export interface RuntimeOptions {
  modelRepairReportingEnabled?: boolean;
  recoveryGuidanceLimit?: number;
  repairsEnabled?: boolean;
  disabledRepairs?: readonly string[];
}

export function createRuntime(options: RuntimeOptions = {}): WelderRuntime {
  return {
    stats: createStats(),
    recovery: createRecoveryState(options.recoveryGuidanceLimit),
    repairWarnings: createRepairWarningState(),
    enabled: options.repairsEnabled ?? true,
    disabledRepairs: new Set(options.disabledRepairs ?? []),
    modelRepairReportingEnabled: options.modelRepairReportingEnabled ?? false,
  };
}

export function resetSessionState(runtime: WelderRuntime): void {
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
  runtime.repairWarnings = createRepairWarningState();
}
