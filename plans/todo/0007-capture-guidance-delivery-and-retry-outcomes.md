---
id: TASK-0007
title: Capture guidance delivery and retry outcomes
status: doing
depends_on: [TASK-0006]
priority: high
tags: [observability, dataset, privacy]
---

# Capture guidance delivery and retry outcomes

## Problem
Current telemetry records repairs and failures but does not reliably link delivered repair warnings or factual result enrichment to the next relevant tool-call outcome. Offline evaluation needs episode-level evidence to learn whether these action-specific messages prevented recurrence or improved recovery.

## Context
Add privacy-preserving episode correlation around repair warnings and factual result enrichment. Generic recovery guidance is out of scope. Record delivery and bounded next-relevant-call outcome without logging argument values, source text, prompts, or model responses.

Define deterministic correlation semantics: originating event, guidance snapshot, target tool, maximum turn/time window, and terminal outcome.

## Acceptance criteria
- [ ] Action-specific message delivery has stable episode/correlation identifier.
- [ ] Outcomes distinguish valid without repair, repaired, failed, unrelated call, and expired window.
- [ ] Provider, model, tool, repair action/error kind, and input keys remain available.
- [ ] No user content or argument values enter welder JSONL.
- [ ] Tests cover successful retry, repeated repair, failure, unrelated calls, expiration, and recorder failure.
- [ ] Existing logs and commands remain backward compatible.
- [ ] A sample report measures episode count and label coverage.

## Notes
Do not infer success only from absence of an error. Require an observed relevant call/result pair.

