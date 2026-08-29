---
id: TASK-0012
title: Evaluate model-specific guidance profiles
status: todo
depends_on: [TASK-0010, TASK-0011]
priority: low
tags: [models, guidance, overfitting]
---

# Evaluate model-specific guidance profiles

## Problem
Provider and model families produce different malformed call patterns, but per-model profiles increase configuration cardinality and overfitting risk. Segment guidance only when held-out evidence proves a global profile is insufficient.

## Context
Use global winner as baseline. Create provider/model profiles only for segments with enough independent sessions and repeated failure patterns. Keep one global fallback.

## Acceptance criteria
- [ ] Minimum sample and independent-session thresholds are defined before segmentation.
- [ ] Profiles are evaluated on held-out sessions from same model family.
- [ ] Global profile remains fallback for unknown and low-volume models.
- [ ] Added configuration and token cost are measured.
- [ ] Profile is accepted only when it beats global baseline by TASK-0006 threshold.
- [ ] Sparse or unstable segments are explicitly rejected.
- [ ] Result documents expiry/re-evaluation policy for model upgrades.

## Notes
Model IDs change. Avoid permanent profiles based on one transient release.

