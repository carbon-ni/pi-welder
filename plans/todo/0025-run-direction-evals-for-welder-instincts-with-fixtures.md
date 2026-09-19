---
id: TASK-0025
title: Run direction evals for welder instincts with fixtures
status: doing
depends_on: []
priority: high
tags: [eval, fixtures, repairs, typesafe, direction]
---

# Run direction evals for welder instincts with fixtures

## Problem
We ship repairs, guidance, and a shadow selector on intuition plus unit tests, but never measure aggregate direction: do the repair instincts fire on real failure shapes, and is Jev's abstention conservatism a property of the task or of our prompts. The TASK-0008 bench harness and TASK-0013 edit-selection eval already exist but have not been run against current behavior; a fixture-based direction readout would tell us which instincts are healthy before we invest further.

## Desired outcome
A direction report scoring each instinct family on fixtures, plus a reusable fixture corpus, so future changes get before/after eval numbers.

## Context
Governance line: fixture evals are **direction evidence only**. They never count toward the promotion gate (real reviewed labels only) and never justify runtime behavior changes by themselves.

Existing machinery: `src/bench/` (dataset, runner, sealed holdout, baselines, lab, smoke) from TASK-0008; `src/bench/edit-selection.ts` from TASK-0013 with predeclared thresholds; the miner from TASK-0023 for corpus-derived shapes.

## Acceptance criteria

### Phase 1 — offline direction readout (no API)
- [ ] Bench baselines run end-to-end on current code; scores captured.
- [ ] Corpus-derived fixture suite: freeze sanitized real failure shapes (edit mismatch variants, arg-shape malformations, read ENOENT/EISDIR) with expected outcomes.
- [ ] Repair-yield metric: fraction of fixture failures each active repair rule would resolve; rules that never fire are flagged.
- [ ] Deterministic: identical runs produce identical reports.

### Phase 2 — Jev confidence probe (opt-in API, synthetic content only)
- [ ] Fixture ambiguous-edit scenarios with known-correct ordinals across difficulty tiers (strong surrounding context → genuinely ambiguous).
- [ ] Measure abstention rate and confidence distribution per tier through the existing edit-selection eval contract.
- [ ] Answers the TASK-0024 hypothesis: is 0.9+ reachable at all, and on which tier.

### Report
- [ ] One report: per-instinct scores, flagged dead rules, Jev tier curves, and explicit "direction evidence only" label.
- [ ] npm script or documented command to re-run the full eval.

## Non-goals
- Promotion evidence or gate changes.
- Prompt tuning in this task (probe measures; a follow-up task tunes if numbers say so).
- New runtime behavior.
