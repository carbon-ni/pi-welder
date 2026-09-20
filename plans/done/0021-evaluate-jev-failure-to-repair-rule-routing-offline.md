---
id: TASK-0021
title: Evaluate Jev failure-to-repair-rule routing offline
status: done
depends_on: []
priority: high
tags: [typesafe, routing, repairs, experiment, offline]
---

# Evaluate Jev failure-to-repair-rule routing offline

## Problem
Some tool failures get no repair because picking the right existing deterministic rule needs reading error text semantically; keyword routing is brittle. A bounded classifier selecting among existing rule IDs (or none) has visible, non-mutating failure modes, but no evidence exists that Jev routes correctly on welder's real failure corpus.

## Desired outcome
An offline evaluation report with a route / don't-route / needs-more-data recommendation. No runtime integration.

## Context
This is the safe shape of classify-then-repair: the classifier output space is bounded to existing deterministic repair rule IDs plus "none". A wrong selection produces a failed or visible repair, never a wrong mutation. Compare against always-none and any deterministic keyword baseline.

Dataset: historical failures from the existing `.pi/welder-log` corpus (which carries `errorText`). Error text can embed paths and source, so every transmitted field passes through the existing `redactShadowText` sanitizer; unsanitizable cases drop out.

Owner explicitly sequenced this experiment after reviewing the first `jeq` session-intent probe. Jev is evaluated only on cases left unresolved by deterministic routing; otherwise it adds no value.

## Predeclared action policy

- Deterministic veto and existing rule applicability checks run before Jev.
- Jev sees only unresolved cases and returns one enumerated existing rule ID or `none`.
- Automatic-action candidate requires confidence >=0.99, deterministic rule validation, and side-effect-free or reversible behavior.
- Evaluation requires at least 30 high-confidence labeled unresolved cases and precision >=0.99 at the threshold. Any unsafe/wrong mutating repair at or above the action threshold rejects promotion; below-threshold wrong predictions are disclosed calibration evidence and abstain operationally.

## Acceptance criteria
- [ ] Output schema permits only enumerated rule IDs from the live repairs registry or "none"; unknown output fails closed.
- [ ] Evaluation harness runs offline over the historical corpus; no production traffic, no code changes to runtime.
- [ ] Baselines reported: always-none, and deterministic keyword matching if implementable cheaply.
- [ ] Metrics: routing precision, coverage, abstention, latency; wrong-rule selections counted and classified as visible non-mutating failures.
- [ ] Redaction verified: captured outbound requests contain no paths, secrets, or raw source beyond capped redacted error text.
- [ ] Decision record reports overall and confidence>=0.99 precision, deterministic-baseline coverage, marginal Jev coverage, unsafe/wrong selections, and a route / don't-route / needs-more-data recommendation.

## Non-goals
- Classifying intent to generate or rewrite tool-call content (shape 3 — refused).
- Any runtime repair behavior change.
- Training or fine-tuning anything.
