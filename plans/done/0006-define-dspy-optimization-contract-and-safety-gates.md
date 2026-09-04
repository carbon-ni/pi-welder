---
id: TASK-0006
title: Define DSPy optimization contract and safety gates
status: done
depends_on: []
priority: high
tags: [dspy, experiment, safety]
---

# Define DSPy optimization contract and safety gates

## Problem
DSPy can search many prompt and demonstration variants, but pi-welder has no agreed objective, safety gate, or adoption threshold. Without a fixed experiment contract, optimization can reward repaired calls, overfit sessions, or trade reliability for hidden semantic risk.

## Context
Define experiment before implementation. Treat semantic mutation as hard failure, not weighted tradeoff. Prefer time-ordered session splits so similar calls from one session cannot leak across train and holdout sets.

Candidate score should cover unrepaired validity, successful execution, recurrence, tool-call count, latency, and token cost. Generic recovery guidance has been removed. Compare any optimizer only on messages that transparently describe an actual deterministic repair or add factual action-specific context, using current repair warnings and no-message behavior as baselines.

## Acceptance criteria
- [ ] Primary outcome and secondary cost metrics are explicit and computable.
- [ ] Content fields, paths, and intended replacements have hard safety invariants.
- [ ] Train, development, and untouched holdout split rules prevent session leakage.
- [ ] Baselines include current repair warnings and no-message behavior; generic recovery guidance is excluded.
- [ ] Fixed seeds, model versions, call budget, timeout, and retry policy are recorded.
- [ ] Go/no-go thresholds define minimum gain and zero tolerated safety regressions.
- [ ] Runtime and offline responsibilities are explicit.

## Notes
DSPy availability is capability, not justification. This task can conclude that data or metrics are insufficient.

Completed contract: `plans/contracts/dspy-optimization-contract.md` version 2. Candidate messages are structurally limited to actual repair transparency or factual result enrichment; generic failure guidance is ineligible. Evidence: `.tmp/reports/04-09-26/task-0006-dspy-contract.md`.

