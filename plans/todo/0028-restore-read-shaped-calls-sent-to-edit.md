---
id: TASK-0028
title: Restore read-shaped calls sent to edit
status: doing
depends_on: []
priority: high
tags: [edit, read, repair, tool-shape, safety]
---

# Restore read-shaped calls sent to edit

## Problem
The corpus contains 378 edit schema failures, including calls whose arguments exactly match read operations. The agent's intent is often recoverable from shape alone, but welder currently lets the edit fail and spends another turn on a retry. We need a deterministic, transparent restoration for the side-effect-free read case.

## Desired outcome
An `edit` call containing only a valid read argument shape is restored to the equivalent `read` operation when Pi supports safe tool-identity replacement. Otherwise, the invalid edit is stopped and returns one concrete corrected read call, without generic advice or false repair claims.

## Acceptance criteria
- [ ] Verify Pi's current extension API from official local docs/examples: whether a `tool_call` hook can replace tool identity or safely invoke/return another tool.
- [ ] Recognize only closed read shapes with a string path and no `edits`, `oldText`, or `newText` fields:
  - `path` plus optional integer `offset`/`limit`;
  - `path`, integer `startLine`, integer `endLine`, converted deterministically to `offset=startLine`, `limit=endLine-startLine+1`.
- [ ] Reject ambiguous, mixed, invalid-range, content-bearing, or unknown-field calls from this restoration without mutation; existing independent structural repair rules remain eligible.
- [ ] Prefer actual reroute when the host API supports it; otherwise block the doomed edit and emit the exact corrected `read` call once.
- [ ] Restoration is transparent and recorded as a distinct action; it never reports a successful edit.
- [ ] No Jev/model call, filesystem pre-read, source logging, or path rewriting.
- [ ] Tests cover both recognized shapes, mixed edit/read fields, invalid ranges, unknown fields, non-edit tools, disabled repairs, and host-capability fallback.
- [ ] Mining/effectiveness can later correlate the restored call with a successful read.

## Non-goals
- Inferring between multiple plausible tools.
- Reconstructing edit content.
- Rerouting any operation to a mutating tool.
