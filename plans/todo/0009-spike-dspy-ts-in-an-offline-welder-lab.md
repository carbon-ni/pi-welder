---
id: TASK-0009
title: Spike DSPy.ts in an offline Welder Lab
status: doing
depends_on: [TASK-0006]
priority: high
tags: [dspy, spike, offline]
---

# Spike DSPy.ts in an offline Welder Lab

## Problem
The local DSPy.ts library exists, but its modules and text-oriented LM drivers are not yet proven against pi-welder's typed tool-call evaluation shape. A small spike must verify the integration and expose required adapter work before product code depends on it.

## Context
Create smallest offline adapter around `.local/dspy.ts` or published `dspy.ts`. Keep it outside Pi extension runtime. Prove one seeded optimizer can improve a synthetic repair-transparency or factual-enrichment task under the Welder Lab metric. Generic recovery guidance is ineligible.

Investigate gap between DSPy.ts text generation and Pi/OpenRouter native tool-call responses before choosing dependency shape.

## Acceptance criteria
- [ ] Decision records whether to use package, workspace dependency, copied algorithm, or no dependency.
- [ ] Minimal typed module compiles against synthetic trainset and metric.
- [ ] Optimizer seed, candidates, scores, token usage, and cost are inspectable.
- [ ] Static and simple deterministic-search baselines are included.
- [ ] Adapter supports cancellation, timeout, and bounded concurrency.
- [ ] Test uses fake LM and is deterministic.
- [ ] Real-model smoke is opt-in and writes only ignored artifacts.
- [ ] Spike documents native tool-call support gap and next required adapter.

## Notes
Stop if library integration costs more than implementing bounded prompt search directly.

