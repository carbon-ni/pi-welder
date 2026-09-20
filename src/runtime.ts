import { createStats, type Stats } from "./recorder/index.ts";
import { createRecoveryState, type RecoveryState } from "./recovery.ts";
import { createRepairWarningState, type RepairWarningState } from "./repair-warnings.ts";
import { createEpisodeTracker, type EpisodeTracker } from "./episodes.ts";
import { createJevShadow, type JevShadow, type ShadowEvidence } from "./model-recovery/jev-shadow.ts";
import { createProspectiveLabelCollector, type LabelRecord, type ProspectiveLabelCollector } from "./prospective-labels/collector.ts";
import { createReadPathState, type ReadPathState } from "./read-recovery/state.ts";
import { READ_PATH_EVIDENCE } from "./read-recovery/evidence-gate.ts";
import type { JevClient } from "./infra/typesafe.ts";
import { clearBashRouteTokens, createBashRouteState, invalidateBashRoutes, type BashRouteState } from "./command-routing/wrapper.ts";

export interface WelderRuntime {
  stats: Stats;
  recovery: RecoveryState;
  repairWarnings: RepairWarningState;
  episodes: EpisodeTracker;
  enabled: boolean;
  disabledRepairs: ReadonlySet<string>;
  modelRepairReportingEnabled: boolean;
  sourceShadowingEnabled: boolean;
  /** TASK-0022 opt-in; separate from source-shadow consent. */
  readPathRepairEnabled: boolean;
  /** TASK-0034 opt-in; exact bash-shaped wrong-tool execution. Default false. */
  commandReroutingEnabled: boolean;
  /** Bounded one-use token state for the bash-routing wrappers. */
  bashRouteState: BashRouteState;
  /**
   * True only when the predeclared evidence gate passes. Runtime mutation of
   * read paths additionally requires this; it stays false until the gate does.
   */
  readPathMutationEnabled: boolean;
  readPathState: ReadPathState;
  jevClient?: JevClient;
  /** Separate client: read-path repair uses its own question/instructions. */
  readPathClient?: JevClient;
  jevShadow?: JevShadow;
  /** TASK-0037 local-only prospective label collector. Never executes. */
  prospectiveLabelsEnabled: boolean;
  prospectiveLabels?: ProspectiveLabelCollector;
  /** Set by handlers to persist privacy-safe label records. */
  onProspectiveLabel?: (record: LabelRecord) => void;
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
  readPathRepairEnabled?: boolean;
  commandReroutingEnabled?: boolean;
  prospectiveLabelsEnabled?: boolean;
  /** Test-only override; production derives from the frozen evidence verdict. */
  readPathMutationEnabled?: boolean;
  jevClient?: JevClient;
  readPathClient?: JevClient;
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
    readPathRepairEnabled: options.readPathRepairEnabled ?? false,
    commandReroutingEnabled: options.commandReroutingEnabled ?? false,
    prospectiveLabelsEnabled: options.prospectiveLabelsEnabled ?? false,
    bashRouteState: createBashRouteState({
      isEnabled: () => runtime.enabled && runtime.commandReroutingEnabled && !runtime.disabledRepairs.has("route-to-bash"),
    }),
    readPathMutationEnabled: options.readPathMutationEnabled ?? READ_PATH_EVIDENCE.passed,
    readPathState: createReadPathState(),
    jevClient: options.jevClient,
    readPathClient: options.readPathClient,
    shadowEvidence: [],
  };
  resetJevShadow(runtime);
  return runtime;
}

export function resetSessionState(runtime: WelderRuntime): void {
  runtime.prospectiveLabels = createProspectiveLabelCollector({
    isEnabled: () => runtime.prospectiveLabelsEnabled,
    sessionId: () => runtime.stats.sessionId ?? "unknown",
    onLabel: (record) => runtime.onProspectiveLabel?.(record),
  });
  void runtime.jevShadow?.shutdown();
  const maxFailures = runtime.recovery.maxFailures;
  runtime.stats = createStats();
  runtime.recovery = createRecoveryState(maxFailures);
  runtime.repairWarnings = createRepairWarningState();
  runtime.episodes = createEpisodeTracker();
  runtime.shadowEvidence = [];
  runtime.readPathState = createReadPathState();
  invalidateBashRoutes(runtime.bashRouteState);
  resetJevShadow(runtime);
}

/**
 * Every mutation that can change bash-route eligibility goes through one of
 * these setters. Each invalidation bumps the policy epoch, so a token prepared
 * before a transition cannot be revived by an off -> on cycle.
 */
export function setRepairsEnabled(runtime: WelderRuntime, enabled: boolean): void {
  if (runtime.enabled === enabled) return;
  runtime.enabled = enabled;
  invalidateBashRoutes(runtime.bashRouteState);
}

export function setCommandReroutingEnabled(runtime: WelderRuntime, enabled: boolean): void {
  if (runtime.commandReroutingEnabled === enabled) return;
  runtime.commandReroutingEnabled = enabled;
  invalidateBashRoutes(runtime.bashRouteState);
}

export function setDisabledRepairs(runtime: WelderRuntime, names: Iterable<string>): void {
  const next = new Set(names);
  const routeChanged = next.has("route-to-bash") !== runtime.disabledRepairs.has("route-to-bash");
  runtime.disabledRepairs = next;
  if (routeChanged) invalidateBashRoutes(runtime.bashRouteState);
}

export function setBashRouteTrust(runtime: WelderRuntime, trusted: boolean): void {
  const previous = runtime.bashRouteState.isTrusted();
  runtime.bashRouteState.isTrusted = () => trusted;
  if (previous !== trusted) invalidateBashRoutes(runtime.bashRouteState);
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
