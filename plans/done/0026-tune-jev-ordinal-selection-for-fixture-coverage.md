---
id: TASK-0026
title: Tune Jev ordinal selection for fixture coverage
status: done
depends_on: []
priority: high
tags: [typesafe, eval, fixtures, edit, safety]
---

# Tune Jev ordinal selection for fixture coverage

## Problem
The Jev fixture probe is safe but nearly always abstains: 1 correct selection and 11 abstentions across 12 synthetic cases. We need to test whether prompt/schema changes make the bounded ordinal classifier useful without trading abstentions for wrong-target selections.

## Desired outcome
A measured prompt/schema variant, or an evidence-backed decision to keep the current abstention behavior. Runtime behavior and promotion gates remain unchanged.

## Baseline
Frozen TASK-0025 direction fixture result: 12 synthetic cases across strong, weak, and genuinely ambiguous context; 1 correct selection, 11 abstentions, 0 wrong selections. This is direction evidence only, not promotion evidence.

## Acceptance criteria
- [ ] Tune only the Jev question/instructions/schema adapter; candidate generation, ordinals, fixtures, and scoring remain unchanged.
- [ ] Evaluate one bounded variant at a time against all three fixture tiers.
- [ ] Report selections, correct, wrong-target, abstentions, confidence distribution, and latency by tier.
- [ ] Any wrong-target selection is a hard failure; no variant is recommended for runtime if it introduces one.
- [ ] No runtime mutation or promotion-gate change.
- [ ] Synthetic payloads only; no repository paths, source, edit text, or secrets leave the machine.
- [ ] Final report recommends keep, adopt for further shadow evaluation, or reject, with before/after numbers.

## Non-goals
- Auto-applying Jev choices.
- Tuning the confidence threshold after seeing results.
- Treating synthetic fixtures as real-label promotion evidence.
