import { createStats, type Stats } from "./recorder.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  enabled: boolean;
}

export function createRuntime(): WelderRuntime {
  return {
    stats: createStats(),
    recovery: createRecoveryState(),
    enabled: true,
  };
}

export function resetSessionState(runtime: WelderRuntime): void {
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
}
