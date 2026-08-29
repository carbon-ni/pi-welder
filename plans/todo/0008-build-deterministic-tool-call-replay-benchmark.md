---
id: TASK-0008
title: Build deterministic tool-call replay benchmark
status: todo
depends_on: [TASK-0007]
priority: high
tags: [benchmark, replay, evaluation]
---

# Build deterministic tool-call replay benchmark

## Problem
We cannot compare current guidance with optimized candidates safely against live side-effecting tools. We need a bounded replay harness with an untouched holdout set and deterministic validators before spending optimizer calls.

## Context
Build offline evaluator from recorded episodes plus hand-authored edge fixtures. Tools must be replaced by schema validators and deterministic fakes. No filesystem, shell, network, or other side effect may execute during replay.

Use native tool-call output when target provider adapter supports it. If evaluation uses text JSON instead, label distribution mismatch and do not treat result as production proof.

## Acceptance criteria
- [ ] Loader validates and rejects incomplete or content-bearing episodes.
- [ ] Replay invokes only deterministic fake tools/validators.
- [ ] Current-guidance and no-guidance baselines run end to end.
- [ ] Result includes score, failures, repairs, calls, tokens, latency, provider/model, and error class.
- [ ] Train/development runs cannot read holdout labels or results.
- [ ] Model calls have timeout, retry cap, concurrency cap, and cost budget.
- [ ] Mocked happy and unhappy tests are deterministic.
- [ ] One bounded real-model smoke run produces a local ignored report.

## Notes
A replay benchmark that cannot reproduce baseline behavior is not suitable for optimization.

