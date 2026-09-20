---
id: TASK-0032
title: Evaluate probabilistic occurrence selection for non-unique edits
status: doing
depends_on: [TASK-0030]
priority: high
tags: [edit, not-unique, occurrences, jeq, evidence, safety]
---

# Evaluate probabilistic occurrence selection for non-unique edits

## Problem
`EDIT_NOT_UNIQUE` has bounded occurrence candidates already present in the target file. We need to determine whether session context plus Jev can identify the intended occurrence with mutation-safe precision, using later successful context extensions as hidden labels.

## Desired outcome
An offline decision on whether Jev can select one existing occurrence safely enough to justify a future shadow repair. Jev selects an ordinal or `none`; deterministic code constructs and validates any unique edit.

## Method

1. Mine non-unique single-edit failures with 2–5 occurrences and a later successful same-path edit within three calls.
2. Reconstruct the source snapshot available at failure from bounded session evidence. A following read may reconstruct environmental state only when no user event or mutation occurs before it; it is never an intent input.
3. Deterministically construct the smallest prefix/suffix extension that uniquely identifies each occurrence. Extend `newText` with identical untouched context.
4. Use the later successful edit only to label the intended occurrence. Hide all future actions/content from Jev.
5. Ask Jev which occurrence hypothesis best explains intent: ordinal 1–5 or `none`.
6. Compare with first-occurrence and nearest-recent-read deterministic baselines.

## Acceptance criteria
- [ ] Report attrition from the 937 mined `EDIT_NOT_UNIQUE` episodes and the 83 locator-extension signals through source reconstruction, 2–5 occurrence eligibility, unique candidate construction, and hidden labeling.
- [ ] Use at least 30 labelable cases across distinct sessions or return insufficient evidence.
- [ ] Candidate construction is deterministic, bounded, and proves: exactly one occurrence changes; untouched prefix/suffix is identical; replacement content is never generated.
- [ ] Jev requests contain no paths, source, edit text, identifiers, commands, credentials, raw conversation, or future behavior.
- [ ] Requests include only closed pre-failure intent signals and per-occurrence structural features: ordinal, position bucket, recent-read relation/distance, and required-context-length buckets.
- [ ] Use installed `jeq`, zero retries, closed Choice criteria, hardened probability parsing, and captured requests/results.
- [ ] Report candidate-set coverage, top-1/top-N recall, accuracy/calibration/abstention, precision and coverage at confidence >=0.90 and >=0.99, per-session concentration, and baseline comparisons.
- [ ] Promotion requires candidate-set coverage >=0.95, Jev beating deterministic baselines, and at least 30 selections at the chosen threshold with zero wrong mutations.
- [ ] No runtime integration in this task.

## Non-goals
- Letting Jev generate code, anchors, replacements, paths, or commands.
- Automatically editing based on confidence alone.
- Weakening gates because coverage is low.
