---
id: TASK-0027
title: Observe live Jev shadow outcomes
status: done
depends_on: []
priority: normal
tags: [typesafe, shadow, observability, metrics, safety]
---

# Observe live Jev shadow outcomes

## Problem
Source shadowing is running asynchronously, but its behavior is hard to inspect: we cannot quickly see whether requests are eligible, selecting, abstaining, timing out, or accumulating labels. Without metadata-only observability, later effectiveness checks require manual JSONL inspection and risk confusing activity with accuracy.

## Desired outcome
A local, metadata-only session and historical report that makes shadow activity, coverage, failure modes, latency, and labels easy to inspect without exposing source or changing tool behavior.

## Acceptance criteria

- [ ] Aggregate existing closed shadow evidence without reading or emitting source windows, paths, edit text, credentials, or provider payloads.
- [ ] Report submitted/completed counts, selected/abstained/low-confidence counts, confidence buckets, p50/p95 latency, terminal status/error classes, and label states (pending/provisional/correct/incorrect/unresolved).
- [ ] Distinguish activity metrics from effectiveness metrics: no precision claim without reviewed labels; no eligible-case denominator unless eligibility is explicitly instrumented.
- [ ] Provide an interactive `/welder-shadow-stats` command for the current session and a deterministic CLI for historical JSONL logs.
- [ ] Empty logs and malformed/legacy events fail closed with clear zero/unknown values.
- [ ] Report output contains metadata only and is byte-deterministic for the same input.
- [ ] Tests cover abstention, selection, low confidence, timeout/rate-limit/transport statuses, latency summaries, label aggregation, privacy, and empty input.
- [ ] No runtime mutation, new API calls, or promotion-gate changes.

## Non-goals

- Inferring precision from unlabeled or synthetic events.
- Logging source payloads for debugging.
- Changing Jev prompts, candidate windows, or repair behavior.
