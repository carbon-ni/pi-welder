/**
 * Guidance episode correlation — links delivered action-specific guidance
 * (repair warnings, factual result-repair enrichment) to the next observed
 * relevant tool call + result outcome.
 *
 * Pure state machine: no I/O, no random, no wall-clock reads. Callers inject
 * a clock and id generator; handlers own logging and swallow its failures.
 *
 * Privacy: records carry only tool name, provider/model, repair action names,
 * and input keys — never argument values, content, prompts, or error text.
 */

export type EpisodeKind = "repair-warning" | "result-repair";
export type EpisodeOutcome = "valid" | "repaired-recurrence" | "repaired-other" | "failed" | "expired";

export interface EpisodeClock {
  now(): number;
  nextId(): string;
}

export interface EpisodeRepairRef {
  field: string;
  action: string;
}

export interface EpisodeSource {
  kind: EpisodeKind;
  toolName: string;
  repairs: EpisodeRepairRef[];
  provider?: string;
  model?: string;
  inputKeys?: string[];
  /** Stable identity for redelivery dedupe (e.g. delivered warning record). */
  dedupeKey?: string;
}

/** Minimal shape of a delivered repair-warning record (see repair-warnings.ts). */
export interface WarningRecordLike {
  toolName: string;
  repairs: EpisodeRepairRef[];
  ts: string;
}

export interface EpisodeRecord {
  episodeId: string;
  kind: EpisodeKind;
  toolName: string;
  provider: string;
  model: string;
  /** Repair action names only — no fields values, no content. */
  repairs: string[];
  inputKeys: string[];
  outcome: EpisodeOutcome;
  window: number;
  unrelatedCalls: number;
  ts: string;
}

export interface EpisodeCallObservation {
  toolName: string;
  actions: string[];
}

export interface EpisodeResultObservation {
  toolName: string;
  isError: boolean;
}

export interface EpisodeTracker {
  open(source: EpisodeSource): EpisodeRecord[];
  openWarnings(records: readonly WarningRecordLike[]): EpisodeRecord[];
  observeCall(observation: EpisodeCallObservation): void;
  observeResult(observation: EpisodeResultObservation): EpisodeRecord[];
  closeAll(): EpisodeRecord[];
  readonly openCount: number;
}

interface OpenEpisode {
  episodeId: string;
  kind: EpisodeKind;
  toolName: string;
  provider: string;
  model: string;
  actionSet: Set<string>;
  inputKeys: string[];
  slotsLeft: number;
  unrelatedCalls: number;
  awaitingResult: boolean;
}

export interface EpisodeTrackerOptions extends Partial<EpisodeClock> {
  /** Same-tool call horizon per episode (contract v2 uses 3). */
  window?: number;
  maxOpen?: number;
}

const DEFAULT_WINDOW = 3;
const DEFAULT_MAX_OPEN = 8;

export function createEpisodeTracker(options: EpisodeTrackerOptions = {}): EpisodeTracker {
  const window = options.window ?? DEFAULT_WINDOW;
  const maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN;
  let idCounter = 0;
  const clock: EpisodeClock = {
    now: options.now ?? (() => Date.now()),
    nextId: options.nextId ?? (() => `ep-${++idCounter}`),
  };

  const openEpisodes: OpenEpisode[] = [];
  const seenDedupeKeys = new Set<string>();
  // Only the most recent call per tool awaits its result; agents loop sequentially,
  // and a superseded call's result cannot be unambiguously attributed.
  const pendingCalls = new Map<string, { actions: string[] }>();

  function toRecord(episode: OpenEpisode, outcome: EpisodeOutcome): EpisodeRecord {
    return {
      episodeId: episode.episodeId,
      kind: episode.kind,
      toolName: episode.toolName,
      provider: episode.provider,
      model: episode.model,
      repairs: Array.from(episode.actionSet),
      inputKeys: episode.inputKeys,
      outcome,
      window,
      unrelatedCalls: episode.unrelatedCalls,
      ts: new Date(clock.now()).toISOString(),
    };
  }

  function close(episode: OpenEpisode, outcome: EpisodeOutcome): EpisodeRecord {
    openEpisodes.splice(openEpisodes.indexOf(episode), 1);
    return toRecord(episode, outcome);
  }

  return {
    open(source: EpisodeSource): EpisodeRecord[] {
      if (source.dedupeKey !== undefined) {
        if (seenDedupeKeys.has(source.dedupeKey)) return [];
        seenDedupeKeys.add(source.dedupeKey);
      }

      const evicted: EpisodeRecord[] = [];
      if (openEpisodes.length >= maxOpen) {
        const oldest = openEpisodes[0];
        if (oldest) evicted.push(close(oldest, "expired"));
      }

      openEpisodes.push({
        episodeId: clock.nextId(),
        kind: source.kind,
        toolName: source.toolName,
        provider: source.provider ?? "",
        model: source.model ?? "",
        actionSet: new Set(source.repairs.map((repair) => repair.action)),
        inputKeys: source.inputKeys ?? [],
        slotsLeft: window,
        unrelatedCalls: 0,
        awaitingResult: false,
      });
      return evicted;
    },

    openWarnings(records: readonly WarningRecordLike[]): EpisodeRecord[] {
      const evicted: EpisodeRecord[] = [];
      for (const record of records) {
        const actions = record.repairs.map((repair) => repair.action).sort().join(",");
        const fields = record.repairs.map((repair) => repair.field).sort().join(",");
        evicted.push(...this.open({
          kind: "repair-warning",
          toolName: record.toolName,
          repairs: record.repairs,
          dedupeKey: `${record.toolName}|${actions}|${fields}|${record.ts}`,
        }));
      }
      return evicted;
    },

    observeCall(observation: EpisodeCallObservation): void {
      pendingCalls.set(observation.toolName, { actions: observation.actions });

      for (const episode of openEpisodes) {
        if (episode.toolName !== observation.toolName) {
          episode.unrelatedCalls++;
          continue;
        }
        if (episode.slotsLeft === 0) {
          close(episode, "expired");
          continue;
        }
        episode.slotsLeft--;
        episode.awaitingResult = true;
      }
    },

    observeResult(observation: EpisodeResultObservation): EpisodeRecord[] {
      const pending = pendingCalls.get(observation.toolName);
      pendingCalls.delete(observation.toolName);
      // Without an observed call we cannot label validity — never infer from silence.
      if (!pending) return [];

      const records: EpisodeRecord[] = [];
      for (const episode of Array.from(openEpisodes)) {
        if (episode.toolName !== observation.toolName || !episode.awaitingResult) continue;
        episode.awaitingResult = false;
        const recurrence = pending.actions.some((action) => episode.actionSet.has(action));
        const outcome: EpisodeOutcome = recurrence
          ? "repaired-recurrence"
          : pending.actions.length > 0
            ? "repaired-other"
            : observation.isError
              ? "failed"
              : "valid";
        records.push(close(episode, outcome));
      }
      return records;
    },

    closeAll(): EpisodeRecord[] {
      return openEpisodes.slice().map((episode) => close(episode, "expired"));
    },

    get openCount(): number {
      return openEpisodes.length;
    },
  };
}

export interface EpisodeCoverage {
  total: number;
  expired: number;
  observed: number;
  byOutcome: Record<string, number>;
}

/** Reduce logged events into episode label coverage. Pure. */
export function episodeCoverage(events: readonly { eventType?: string; outcome?: string }[]): EpisodeCoverage {
  const byOutcome: Record<string, number> = {};
  let total = 0;
  for (const event of events) {
    if (event.eventType !== "episode") continue;
    total++;
    const outcome = event.outcome ?? "unknown";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }
  const expired = byOutcome["expired"] ?? 0;
  return { total, expired, observed: total - expired, byOutcome };
}

/** Bounded markdown report of episode counts and label coverage. Pure. */
export function formatEpisodeReport(events: readonly { eventType?: string; outcome?: string }[]): string {
  const coverage = episodeCoverage(events);
  const lines = ["pi-welder episode coverage"];
  lines.push(`episodes: ${coverage.total}`);
  for (const outcome of Object.keys(coverage.byOutcome).sort()) {
    lines.push(`${outcome}: ${coverage.byOutcome[outcome]}`);
  }
  lines.push(`coverage: ${coverage.observed}/${coverage.total}`);
  return lines.join("\n");
}
