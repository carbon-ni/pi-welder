---
id: TASK-0010
title: Optimize repair transparency messages
status: done
depends_on: [TASK-0008, TASK-0009]
priority: high
tags: [dspy, guidance, experiment]
---

# Optimize repair transparency messages

## Problem
Current repair warnings are hand-written. We do not know which wording prevents repeated malformed calls, which wording only adds tokens, or whether optimized repair transparency can beat the static baseline on held-out episodes.

## Context
Optimize separately:

1. Shared repair-warning introduction.
2. Per-repair-action hints.
3. Omit-message choice.

Generic recovery and messages for repair-free failures are structurally ineligible. Messages must describe an actual deterministic repair, must not invent arguments, and must not claim unobserved execution success.

## Acceptance criteria
- [ ] Candidate space and fixed baselines are versioned.
- [ ] Optimization runs only on train/development episodes.
- [ ] Holdout evaluation follows TASK-0006 thresholds.
- [ ] Results show effect by repair-warning surface and repair action.
- [ ] Token and latency cost are reported beside reliability gain.
- [ ] Content-safety and truthful-error tests have zero regressions.
- [ ] Winner or explicit rejection is documented.
- [ ] No runtime change lands as part of experiment.

## Notes
A shorter message or no message is a valid winner.

Completed as an explicit no-go: current logs contain zero closed real episodes, below the contract threshold of 30 sealed-holdout episodes per repair-action cluster. The offline experiment and sufficiency gate are ready to rerun after evidence accrues; no runtime message changed. Evidence: `.tmp/reports/04-09-26/task-0010-transparency-experiment.md`.

