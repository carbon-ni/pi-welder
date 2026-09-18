---
id: TASK-0020
title: Collect real shadow labels for ambiguous-edit promotion
status: todo
depends_on: [TASK-0019]
priority: high
tags: [edit, typesafe, shadow, evidence, promotion]
---

# Collect real shadow labels for ambiguous-edit promotion

## Problem
The shadow selector ships advisory-only and zero real outcome labels exist. Promotion to runtime mutation requires at least 30 real, held-out, manually reviewed labels and precision at a predeclared confidence threshold; without a dogfooding collection period the promote-or-reject decision stays open indefinitely.

## Desired outcome
A reviewed label set plus a decision record recommending promote, reject, or extend collection — grounded in real sessions, not synthetic cases.

## Context
TASK-0019 ships the collector: opt-in setting plus `TYPESAFE_API_KEY`, bounded redacted windows, metadata-only JSONL evidence, provisional labels from later uniquely-matching successful edits. This task is operational and analytical, not code work: enable it, work normally, review what accrues.

Provisional labels come from correlation, so review must verify ground truth per label by cross-referencing the session transcript (`~/.pi/agent/sessions/`) with shadow evidence via `toolCallId`. The promotion gate from the decision record (`~/.agents/reports/17-09-26/jev-welder-decision-record.md`) governs the verdict.

## Acceptance criteria

### Collection
- [ ] Shadowing is enabled in the owner's real Pi sessions (persisted setting plus nonblank key), disclosed and intentional.
- [ ] Shadow stays advisory for the entire collection period; no runtime mutation behavior changes.
- [ ] Eligible ambiguous edits in real sessions produce shadow evidence records in the session JSONL.

### Labeling and review
- [ ] A documented review protocol: how each provisional label's ground truth is established from the session transcript, and what counts as wrong-target.
- [ ] Each reviewed label maps to candidate count, Jev selection (ordinal/abstain), confidence, and the human-verified intended target.
- [ ] Unresolved cases stay unlabeled and are excluded from precision, with counts reported.

### Decision
- [ ] A predeclared confidence threshold is written down before precision is computed.
- [ ] Either at least 30 reviewed held-out labels, or an explicit insufficient-collection decision with reasons and what would change it.
- [ ] Report computes precision at the threshold, abstention rate, latency, and failure rates; recommends promote, reject, or extend.
- [ ] Any wrong-target label is recorded as a hard-safety violation and blocks promotion.

## Non-goals
- Changing runtime behavior or promoting the selector.
- Synthetic or simulated labels.
- Running the routing experiment (TASK-0021) concurrently during early collection, per the decision record's no-parallelization rule.
