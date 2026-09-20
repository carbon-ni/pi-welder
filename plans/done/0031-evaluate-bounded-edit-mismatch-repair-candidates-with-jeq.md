---
id: TASK-0031
title: Evaluate bounded edit-mismatch repair candidates with jeq
status: done
depends_on: [TASK-0030]
priority: high
tags: [edit, mismatch, candidates, jeq, evidence, safety]
---

# Evaluate bounded edit-mismatch repair candidates with jeq

## Problem
Exact-text edit mismatch is the highest-volume viable repair target, but any automatic mutation requires evidence that a bounded candidate generator contains the agent's eventual successful anchor and that Jev can select it with high empirical precision rather than confidence alone.

## Desired outcome
Decide whether a safe probabilistic edit-mismatch repair is empirically supportable. The decision separates candidate-generator recall from Jev selection precision and rejects promotion when either fails.

## Method

1. Mine exact-text-not-found episodes followed within three calls by a successful same-path edit, with no intervening user message or successful mutation.
2. Reconstruct source available at failure only when session evidence permits it without using the successful edit payload as candidate input.
3. Generate at most five deterministic anchor candidates using closed transformations (line-ending, indentation/whitespace, bounded fuzzy line window, and context extension where available).
4. Label the candidate matching the later successful edit locally; later edit content never enters a Jev request.
5. Jev receives only attempted-call shape, error class, closed pre-failure intent signals, and candidate structural features/ordinals. It chooses one candidate or `none`.
6. Compare Jev selection with a deterministic ranking baseline.

## Acceptance criteria
- [ ] Report corpus attrition at every gate and candidate-generator top-1/top-5 recall.
- [ ] Use at least 30 independently labelable cases across distinct sessions or return an explicit insufficient-evidence verdict.
- [ ] Candidate generation is deterministic, bounded to five, content-preserving, and separately tested.
- [ ] Requests contain no paths, source, commands, edit text, identifiers, credentials, raw conversation, or future behavior.
- [ ] Pre-failure intent is represented only by closed structural/keyword signals extracted locally from up to three prior events.
- [ ] Candidate hypotheses contain ordinal plus closed features such as transformation kind, similarity bucket, uniqueness, relative position bucket, and context-overlap bucket; no text.
- [ ] Use installed `jeq`, zero retries, closed Choice criteria, and hardened probability parsing.
- [ ] Report overall and per-transformation accuracy, calibration, abstention, precision/coverage at confidence >=0.99, and deterministic-baseline comparison.
- [ ] Promotion requires candidate recall >=0.95 and at least 30 high-confidence selections with zero wrong mutations; otherwise reject or keep shadow-only.
- [ ] No runtime integration in this task.

## Non-goals
- Letting Jev generate or rewrite `oldText`, `newText`, paths, or source.
- Weakening thresholds because coverage is low.
- Treating model confidence as correctness.
