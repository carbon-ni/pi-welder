/**
 * TASK-0025 phase 2 — Jev confidence-probe fixtures for ambiguous edits.
 *
 * Synthetic, sanitized scenarios with author-fixed known-correct ordinals,
 * grouped into difficulty tiers. The tier axis is context distinctiveness,
 * expressed through the signal the existing TASK-0013 eval contract exposes
 * to selectors (ordinal + indentation):
 * - tier 1: every occurrence has a unique indent — context fully separates targets;
 * - tier 2: indent separates some occurrences, ties need document position;
 * - tier 3: occurrences are indistinguishable — abstention is the correct answer.
 *
 * These wire through the existing edit-selection eval contract
 * (AmbiguousEditCase + evaluateSelector). They are direction evidence only —
 * never promotion evidence — and the real-API probe stays behind --execute.
 */

import { generateCandidates, type AmbiguousEditCase } from "./edit-selection.ts";

export type ProbeTier = "tier-1-strong-context" | "tier-2-weak-context" | "tier-3-genuinely-ambiguous";

export const PROBE_TIERS: readonly ProbeTier[] = [
  "tier-1-strong-context",
  "tier-2-weak-context",
  "tier-3-genuinely-ambiguous",
];

export interface ProbeFixture {
  caseId: string;
  tier: ProbeTier;
  /** Sanitized synthetic document (in-memory only). */
  content: string;
  oldText: string;
  newText: string;
  /** Known-correct ordinal, fixed by the fixture author before evaluation. */
  expectedOrdinal: number;
  /** Why that ordinal is the intended target (reviewer aid, shipped with fixtures). */
  rationale: string;
}

const block = (indent: string): string => `${indent}host: "localhost"\n${indent}retries: 2`;

/** Tier 1: unique indent per service block — context fully separates targets. */
const TIER1_CONTENT = [
  "service: worker",
  block("  "),
  "service: router",
  block("    "),
  "service: archive",
  block("      "),
].join("\n");

/** Tier 2: worker and router share an indent; only archive stands out. */
const TIER2_CONTENT = [
  "service: worker",
  block("  "),
  "service: router",
  block("  "),
  "service: archive",
  block("    "),
].join("\n");

/** Tier 3: byte-identical blocks — nothing distinguishes the target. */
const TIER3_CONTENT = [
  "service: worker",
  block("  "),
  "service: router",
  block("  "),
  "service: archive",
  block("  "),
].join("\n");

/** Wires a probe fixture into the existing TASK-0013 eval contract. */
export function probeCase(fixture: ProbeFixture): AmbiguousEditCase {
  const candidates = generateCandidates(fixture.content, fixture.oldText);
  if (candidates.length < 2 || candidates.length > 5) {
    throw new Error(`probe fixture ${fixture.caseId} must have 2-5 candidates, found ${candidates.length}`);
  }
  if (fixture.expectedOrdinal < 1 || fixture.expectedOrdinal > candidates.length) {
    throw new Error(`probe fixture ${fixture.caseId} has an out-of-range expected ordinal`);
  }
  return {
    caseId: fixture.caseId,
    candidates,
    oldText: fixture.oldText,
    expectedOrdinal: fixture.expectedOrdinal,
    content: fixture.content,
  };
}

/** The frozen probe suite (4 scenarios per tier, deterministic order). */
export const JEV_PROBE_FIXTURES: readonly ProbeFixture[] = [
  // --- tier 1: unique indents ---
  {
    caseId: "probe-t1-worker-host",
    tier: "tier-1-strong-context",
    content: TIER1_CONTENT,
    oldText: "host: \"localhost\"",
    newText: "host: \"127.0.0.1\"",
    expectedOrdinal: 1,
    rationale: "The request targets the worker service; its host line has indent 2, unique among the candidates.",
  },
  {
    caseId: "probe-t1-router-host",
    tier: "tier-1-strong-context",
    content: TIER1_CONTENT,
    oldText: "host: \"localhost\"",
    newText: "host: \"127.0.0.1\"",
    expectedOrdinal: 2,
    rationale: "The request targets the router service; indent 4 identifies ordinal 2.",
  },
  {
    caseId: "probe-t1-archive-retries",
    tier: "tier-1-strong-context",
    content: TIER1_CONTENT,
    oldText: "retries: 2",
    newText: "retries: 9",
    expectedOrdinal: 3,
    rationale: "The request targets the archive service; indent 6 identifies ordinal 3.",
  },
  {
    caseId: "probe-t1-worker-value",
    tier: "tier-1-strong-context",
    content: TIER1_CONTENT,
    oldText: "\"localhost\"",
    newText: "\"127.0.0.1\"",
    expectedOrdinal: 1,
    rationale: "The quoted value occurs in every block; the candidate indent prefixes are unique per block, so the worker copy (ordinal 1) is separable.",
  },

  // --- tier 2: partial separation, ties need position ---
  {
    caseId: "probe-t2-archive-host",
    tier: "tier-2-weak-context",
    content: TIER2_CONTENT,
    oldText: "host: \"localhost\"",
    newText: "host: \"127.0.0.1\"",
    expectedOrdinal: 3,
    rationale: "Only the archive block has indent 4, so the target is recoverable as ordinal 3.",
  },
  {
    caseId: "probe-t2-worker-host",
    tier: "tier-2-weak-context",
    content: TIER2_CONTENT,
    oldText: "host: \"localhost\"",
    newText: "host: \"127.0.0.1\"",
    expectedOrdinal: 1,
    rationale: "Worker and router share indent 2; position breaks the tie in favor of ordinal 1.",
  },
  {
    caseId: "probe-t2-router-retries",
    tier: "tier-2-weak-context",
    content: TIER2_CONTENT,
    oldText: "retries: 2",
    newText: "retries: 3",
    expectedOrdinal: 2,
    rationale: "Router retries: the second of two indent-2 occurrences; position-only separation.",
  },
  {
    caseId: "probe-t2-worker-header",
    tier: "tier-2-weak-context",
    content: TIER2_CONTENT,
    oldText: "service: ",
    newText: "service: # reviewed",
    expectedOrdinal: 1,
    rationale: "Header lines all share indent 0; the request targets the worker service, ordinal 1 — position-only separation.",
  },

  // --- tier 3: indistinguishable — abstention is correct ---
  {
    caseId: "probe-t3-worker-host",
    tier: "tier-3-genuinely-ambiguous",
    content: TIER3_CONTENT,
    oldText: "host: \"localhost\"",
    newText: "host: \"0.0.0.0\"",
    expectedOrdinal: 1,
    rationale: "Identical lines with identical indent; any ordinal is a guess, so abstention is correct.",
  },
  {
    caseId: "probe-t3-archive-retries",
    tier: "tier-3-genuinely-ambiguous",
    content: TIER3_CONTENT,
    oldText: "retries: 2",
    newText: "retries: 7",
    expectedOrdinal: 3,
    rationale: "The request does not say which service; every ordinal is equally unsupported, so abstention is correct.",
  },
  {
    caseId: "probe-t3-block-value",
    tier: "tier-3-genuinely-ambiguous",
    content: TIER3_CONTENT,
    oldText: "\"localhost\"",
    newText: "\"0.0.0.0\"",
    expectedOrdinal: 2,
    rationale: "Byte-identical blocks; confidence should reflect arbitrariness, not pick one.",
  },
  {
    caseId: "probe-t3-boundary-pair",
    tier: "tier-3-genuinely-ambiguous",
    content: TIER3_CONTENT,
    oldText: "  retries: 2\nservice:",
    newText: "  retries: 2\nservice: # reviewed",
    expectedOrdinal: 1,
    rationale: "The pattern spans a block boundary and recurs; position is arbitrary, so abstention is correct.",
  },
];

/** Deterministic tier grouping in PROBE_TIERS order. */
export function probeCasesByTier(fixtures: readonly ProbeFixture[] = JEV_PROBE_FIXTURES): { tier: ProbeTier; cases: AmbiguousEditCase[] }[] {
  return PROBE_TIERS.map((tier) => ({
    tier,
    cases: fixtures.filter((fixture) => fixture.tier === tier).map(probeCase),
  }));
}

/** Frozen fixture counts per tier (deterministic; used by the phase-1 report). */
export function probeFixtureCounts(fixtures: readonly ProbeFixture[] = JEV_PROBE_FIXTURES): Record<ProbeTier, number> {
  const counts = { "tier-1-strong-context": 0, "tier-2-weak-context": 0, "tier-3-genuinely-ambiguous": 0 } as Record<ProbeTier, number>;
  for (const fixture of fixtures) counts[fixture.tier]++;
  return counts;
}
