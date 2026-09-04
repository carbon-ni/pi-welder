---
id: TASK-0016
title: Guide missing nested edit fields
status: todo
depends_on: []
priority: high
tags: [edit, schema, recovery]
---

# Guide missing nested edit fields

## Problem
Malformed edit entries missing oldText or newText receive generic recovery guidance, causing avoidable retries without identifying the exact invalid field.

## Context
Latest Luna-session mining found an edit entry missing `newText`. The schema error identified the nested field, but recovery reduced it to generic shape guidance.

## Acceptance criteria
- [ ] Tests cover missing nested `oldText` and `newText` fields.
- [ ] Recovery identifies the exact missing field and edit index when available.
- [ ] Guidance never invents replacement or source text.
- [ ] Valid edits and unrelated schema failures remain unchanged.
- [ ] Lint and package checks pass.

## Notes
Repair structure only when intent is explicit; otherwise give precise retry guidance.

