---
id: TASK-0010
title: Optimize repair warnings and recovery guidance
status: todo
depends_on: [TASK-0008, TASK-0009]
priority: high
tags: [dspy, guidance, experiment]
---

# Optimize repair warnings and recovery guidance

## Problem
Current repair warnings and recovery hints are hand-written. We do not know which wording prevents repeated malformed calls, which wording only adds tokens, or whether optimized guidance can beat the static baseline on held-out episodes.

## Context
Optimize separately:

1. Shared repair-warning introduction.
2. Per-repair-action hints.
3. Shared recovery introduction.
4. Per-error-kind recovery hints.
5. Omit-guidance choice.

Keep original error text available to agent. Guidance must not invent arguments or claim execution succeeded.

## Acceptance criteria
- [ ] Candidate space and fixed baselines are versioned.
- [ ] Optimization runs only on train/development episodes.
- [ ] Holdout evaluation follows TASK-0006 thresholds.
- [ ] Results show effect by warning/recovery surface and error class.
- [ ] Token and latency cost are reported beside reliability gain.
- [ ] Content-safety and truthful-error tests have zero regressions.
- [ ] Winner or explicit rejection is documented.
- [ ] No runtime change lands as part of experiment.

## Notes
A shorter message or no message is a valid winner.

