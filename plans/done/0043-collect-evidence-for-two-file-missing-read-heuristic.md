---
id: TASK-0043
title: Collect evidence for two-file missing-read heuristic
status: done
depends_on: [TASK-0039]
priority: high
tags: [read, enoent, heuristic, shadow, evidence]
---

# Collect evidence for two-file missing-read heuristic

## Problem
Historical mining found only 14 provisional labels for missing reads whose current parent has exactly two files. Extension-only selection was unsafe (40–60% precision), test/implementation role was 4/4, and unique filename distance was 13/13 but included weak unrelated next-read labels. We need a reproducible, metadata-safe evaluator before changing runtime reads.

## Desired outcome
A deterministic two-file shadow evaluator and mining command that classifies candidate structure, predicts an ordinal or abstains, correlates bounded later successful reads, and reports promotion evidence without mutating read calls or sending data off-machine.

## Acceptance criteria
- [ ] Pure heuristic accepts requested basename plus exactly two candidate basenames and returns a known ordinal/reason or abstains.
- [ ] Explicit test/implementation pairs use normalized stem and requested role (`test`/`spec` versus implementation).
- [ ] Same-stem extension variants may select a unique counterpart; plain extension equality alone never selects.
- [ ] Filename-distance predictions require a unique winner and a predeclared margin/normalization threshold; unrelated names abstain.
- [ ] Mining scans missing-read failures and at most the next three read calls in the same session; only a successful call to one of the two candidates is a provisional label.
- [ ] Persisted evidence contains session/call IDs, candidate count, closed feature categories, predicted/observed ordinal, reason, and outcome only—no paths, filenames, contents, cwd, or error text.
- [ ] Report corpus attrition, coverage, precision by reason, session concentration, and at least 30 reviewed labels before recommending runtime promotion.
- [ ] Add an npm command for repeatable offline evaluation; no Jev/API calls.
- [ ] Runtime behavior is unchanged: no path mutation, extra reads, result rewriting, or messages.

## Frozen starting evidence
- Missing-read pairs: 1,421.
- Current parent exactly two files: 103.
- Labelable: 14.
- Extension: 2/5 simple, 3/5 compound.
- Test/implementation role: 4/4.
- Unique filename distance: 13/13, provisional and noisy.
