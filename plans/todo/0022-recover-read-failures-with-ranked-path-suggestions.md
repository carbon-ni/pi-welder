---
id: TASK-0022
title: Recover read failures with ranked path suggestions
status: todo
depends_on: []
priority: normal
tags: [read, recovery, guidance, typesafe, evidence]
---

# Recover read failures with ranked path suggestions

## Problem
Read tool calls fail on directories and missing files, and the agent retries blind: no listing hint, no nearest-path candidates. Recovery guidance today adds no factual context for these failures, so retry loops burn turns. We need suggestions that are factual and specific, with semantic ranking only if the deterministic floor proves insufficient.

## Desired outcome
After a failed `read`, guidance that states the failure class factually and offers concrete next actions: the directory listing command when a folder was read, or the nearest existing file candidates when the path is missing. Suggestions must be deterministic by default; Jev ranking is a later, opt-in layer only where evidence proves the deterministic floor insufficient.

## Context
Established guidance pattern: TASK-0015/0016/0017 added failure-specific guidance that survives the standing rule — welder messages are acceptable only when they add new factual, tool-specific context. This task follows that shape.

The Jev layer, if earned, reuses the bounded ordinal-or-abstain contract from TASK-0019: Jev ranks among candidates produced deterministically (fd + edit distance), never generates paths. Paths and error text leaving the machine require the same explicit opt-in disclosure as source shadowing; key presence alone is not consent.

## Acceptance criteria

### Phase 1 — evidence (offline, no API)
- [ ] Mine the welder-log corpus for `read` failures; classify shapes (directory-read, missing-file, permission, other) with counts.
- [ ] For missing-file failures with a later successful read in the same session, measure how often the eventual path appears in the deterministic top-1 and top-3 candidates (fd + edit distance).
- [ ] Report states the deterministic hit rates and recommends: Jev ranking needed, or deterministic-only.

### Phase 2 — deterministic guidance (if phase 1 supports any variant)
- [ ] Directory-read failure appends factual guidance: the path is a directory, with a concrete listing command.
- [ ] Missing-file failure appends top-3 nearest existing paths when deterministically found; no message when nothing concrete exists.
- [ ] Guidance never fires on successful reads or non-read tools; no generic advice.

### Phase 3 — Jev ranking (only if phase 1 shows top-3 hit rate below target)
- [ ] Bounded ordinal-or-abstain over deterministic candidates only; abstain leaves the deterministic order.
- [ ] Explicit opt-in disclosure covering path transmission; disabled by default.
- [ ] Offline evaluation on the phase-1 labeled set before any runtime use.

## Non-goals
- Jev generating or rewriting paths.
- Reading file contents to rank candidates.
- Changing the `read` tool itself or repairing its arguments.
