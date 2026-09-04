---
id: TASK-0015
title: Normalize duplicate edit failure variants
status: done
depends_on: []
priority: high
tags: [edit, recovery, observability]
---

# Normalize duplicate edit failure variants

## Problem
Equivalent non-unique edit errors use different wording and classifications, preventing consistent recovery guidance and reliable failure aggregation.

## Context
Latest Luna-session mining found six equivalent duplicate-edit failures. Some use `EDIT_NOT_UNIQUE`; others only say that text occurs multiple times or must be unique.

## Acceptance criteria
- [ ] Tests cover each observed duplicate-edit wording.
- [ ] Failure aggregation classifies equivalent variants consistently where classification is owned here.
- [ ] Unrelated edit failures retain existing classification.
- [ ] Lint and package checks pass.

## Notes
Completed as classification normalization only. User rejected guidance-only behavior because it does not fix the failed call. Do not select a duplicate occurrence automatically.

