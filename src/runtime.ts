import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";
import { createEpisodeTracker, type EpisodeTracker } from "./episodes.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  episodes: EpisodeTracker;
  enabled: boolean;
  disabledRepairs: ReadonlySet<string>;
  modelRepairReportingEnabled: boolean;
}

export interface RuntimeOptions {
  modelRepairReportingEnabled?: boolean;
  recoveryGuidanceLimit?: number;
  repairsEnabled?: boolean;
  disabledRepairs?: readonly string[];
  /** Injected in tests for deterministic ids/timestamps. */
  episodeClock?: { now(): number; nextId(): string };
}

export function createRuntime(options: RuntimeOptions = {}): WelderRuntime {
  return {
    stats: createStats(),
    recovery: createRecoveryState(options.recoveryGuidanceLimit),
    repairWarnings: createRepairWarningState(),
    episodes: createEpisodeTracker(options.episodeClock),
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
  runtime.episodes = createEpisodeTracker();
}
