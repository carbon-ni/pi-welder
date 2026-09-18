---
id: TASK-0021
title: Evaluate Jev failure-to-repair-rule routing offline
status: todo
depends_on: []
priority: low
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

Sequencing: per the TASK-0019 decision record, do not run this while early shadow-label collection (TASK-0020) is the active focus. No hard dependency — start it only after the owner explicitly sequences it.

## Acceptance criteria
- [ ] Output schema permits only enumerated rule IDs from the live repairs registry or "none"; unknown output fails closed.
- [ ] Evaluation harness runs offline over the historical corpus; no production traffic, no code changes to runtime.
- [ ] Baselines reported: always-none, and deterministic keyword matching if implementable cheaply.
- [ ] Metrics: routing precision, coverage, abstention, latency; wrong-rule selections counted and classified as visible non-mutating failures.
- [ ] Redaction verified: captured outbound requests contain no paths, secrets, or raw source beyond capped redacted error text.
- [ ] Decision record written with recommendation and predeclared thresholds.

## Non-goals
- Classifying intent to generate or rewrite tool-call content (shape 3 — refused).
- Any runtime repair behavior change.
- Training or fine-tuning anything.
