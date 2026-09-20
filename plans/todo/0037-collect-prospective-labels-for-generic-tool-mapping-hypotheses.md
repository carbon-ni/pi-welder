---
id: TASK-0037
title: Collect prospective labels for generic tool mapping hypotheses
status: doing
depends_on: [TASK-0036]
priority: high
tags: [routing, labels, runtime, privacy, observability]
---

# Collect prospective labels for generic tool mapping hypotheses

## Problem
Historical sessions provide only one trustworthy label for generic non-exact field mappings. We need local runtime episode collection that correlates malformed validation failures with the next three attempted calls and persists privacy-safe candidate features plus the observed winning ordinal.

## Desired outcome
A local, no-model label collector that accumulates real `{target tool + field mapping}` outcomes for later `jeq` evaluation. Raw argument values exist only in bounded memory during correlation and never enter logs.

## Acceptance criteria
- [ ] Use Pi execution lifecycle events to observe original call arguments before validation and confirm an anchored Pi validation failure before opening a label episode.
- [ ] Generate hypotheses with TASK-0036's verified planner; exact canonical matches and unsupported/unbounded inputs do not open episodes.
- [ ] Compare at most the next three tool calls started after the confirmed failure; parallel siblings started earlier do not count.
- [ ] Label only a call matching one existing plan with unchanged mapped values and a valid target schema; otherwise record unresolved/expired/user-interrupted.
- [ ] Keep raw values in a bounded in-memory store only: maximum episodes, fields, per-value bytes, and aggregate bytes; eviction fails closed.
- [ ] Persist only opaque episode/session IDs, attempted/target tool IDs, safe key tokens, types/closed features, mapping ordinals, outcome, and counts. No raw values, paths, commands, source, credentials, result text, or conversation.
- [ ] Add explicit `mappingLabelCollectionEnabled` setting, default false, with live settings control and session cleanup.
- [ ] No Jev/LLM/API calls, no argument mutation, no tool rerouting, and no execution beyond the agent's original calls.
- [ ] Cover validation confirmation, parallel ordering, three-call expiry, user interruption, matching, ambiguity, eviction, shutdown, privacy, and deterministic persistence.
- [ ] Provide `/welder-stats` visibility for eligible/open/labeled/unresolved/evicted counts.

## Non-goals
- Selecting or applying repairs.
- Persisting raw arguments for later review.
- Running Jev before the label gate is met.
