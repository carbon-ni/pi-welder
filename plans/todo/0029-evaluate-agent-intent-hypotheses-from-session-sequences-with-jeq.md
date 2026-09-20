---
id: TASK-0029
title: Evaluate agent-intent hypotheses from session sequences with jeq
status: doing
depends_on: []
priority: high
tags: [typesafe, jeq, intent, hypotheses, sessions, evaluation]
---

# Evaluate agent-intent hypotheses from session sequences with jeq

## Problem
Existing Jev experiments classify repair rules or policy categories, not the agent's original intent. To use probabilistic repair safely, code must generate explicit competing intent hypotheses from pre-failure session evidence, ask Jev which hypothesis best explains the observation, and score it against hidden future behavior.

## Desired outcome
A session-derived evaluation that tells us whether Jev can identify original intent from bounded prior context—not whether it can repeat error-to-rule mappings.

## Method

1. Extract real failed calls with a later successful recovery in the same session.
2. Hide all events after the failure from Jev.
3. Deterministic code generates 2–4 mutually exclusive, case-specific intent hypotheses plus `uncertain`.
4. `jeq` Choice estimates the probability distribution and confidence over those hypotheses.
5. The later successful call labels which hypothesis was correct, or `unresolvable`.
6. Code—not Jev—maps a supported hypothesis to a repair candidate and applies policy.

## Acceptance criteria
- [ ] At least 30 labeled cases across missing reads, ambiguous edits, edit mismatch/drift, and invalid tool shapes, or an explicit attrition verdict.
- [ ] Jev state contains only pre-failure evidence: attempted tool, argument-key/type shape, failure class, and bounded prior tool names/outcomes. No future-action leakage.
- [ ] Hypotheses are explicit causal claims about intent, not repair-rule names or policy decisions.
- [ ] Ground truth comes only from later successful session behavior and remains hidden from requests.
- [ ] Requests contain no paths, source, commands, edit text, credentials, or conversation text.
- [ ] Use installed `jeq` CLI, zero retries, Choice probabilities preserved; unknown/malformed responses fail closed.
- [ ] Report top-1 accuracy, calibration by confidence bucket, abstention/uncertain behavior, precision at confidence >=0.99, and results per failure family.
- [ ] No runtime integration or auto-repair in this task.

## Non-goals
- Asking Jev which policy or repair rule to execute.
- Generating repairs, paths, commands, or content.
- Treating future actions as input evidence.
