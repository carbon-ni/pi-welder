import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";
import { createEpisodeTracker, type EpisodeTracker } from "./episodes.ts";
import { createJevShadow, type JevShadow, type ShadowEvidence } from "./model-recovery/jev-shadow.ts";
import type { JevClient } from "./infra/typesafe.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  episodes: EpisodeTracker;
  enabled: boolean;
  disabledRepairs: ReadonlySet<string>;
  modelRepairReportingEnabled: boolean;
  sourceShadowingEnabled: boolean;
  jevClient?: JevClient;
  jevShadow?: JevShadow;
  shadowEvidence: ShadowEvidence[];
  /** Set by handlers to persist safe shadow metadata; never receives payloads. */
  onShadowEvidence?: (evidence: ShadowEvidence) => void;
}

export interface RuntimeOptions {
  modelRepairReportingEnabled?: boolean;
  recoveryGuidanceLimit?: number;
  repairsEnabled?: boolean;
  disabledRepairs?: readonly string[];
  sourceShadowingEnabled?: boolean;
  jevClient?: JevClient;
  /** Injected in tests for deterministic ids/timestamps. */
  episodeClock?: { now(): number; nextId(): string };
}

export function createRuntime(options: RuntimeOptions = {}): WelderRuntime {
  const runtime: WelderRuntime = {
    stats: createStats(),
    recovery: createRecoveryState(options.recoveryGuidanceLimit),
    repairWarnings: createRepairWarningState(),
    episodes: createEpisodeTracker(options.episodeClock),
    enabled: options.repairsEnabled ?? true,
    disabledRepairs: new Set(options.disabledRepairs ?? []),
    modelRepairReportingEnabled: options.modelRepairReportingEnabled ?? false,
    sourceShadowingEnabled: options.sourceShadowingEnabled ?? false,
    jevClient: options.jevClient,
    shadowEvidence: [],
  };
  resetJevShadow(runtime);
  return runtime;
}

export function resetSessionState(runtime: WelderRuntime): void {
  void runtime.jevShadow?.shutdown();
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
  runtime.repairWarnings = createRepairWarningState();
  runtime.episodes = createEpisodeTracker();
  runtime.shadowEvidence = [];
  resetJevShadow(runtime);
}

export function setSourceShadowingEnabled(runtime: WelderRuntime, enabled: boolean): void {
  runtime.sourceShadowingEnabled = enabled;
  void runtime.jevShadow?.shutdown();
  resetJevShadow(runtime);
}

function resetJevShadow(runtime: WelderRuntime): void {
  runtime.jevShadow = runtime.sourceShadowingEnabled && runtime.jevClient
    ? createJevShadow({
        client: runtime.jevClient,
        onEvidence: (evidence) => {
          runtime.shadowEvidence.push(evidence);
          runtime.onShadowEvidence?.(evidence);
        },
      })
    : undefined;
}
