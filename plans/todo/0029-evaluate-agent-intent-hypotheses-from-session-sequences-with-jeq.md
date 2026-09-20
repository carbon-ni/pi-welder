---
id: TASK-0029
title: Evaluate agent-intent hypotheses from session sequences with jeq
status: todo
depends_on: [TASK-0030]
priority: high
tags: [typesafe, jeq, intent, hypotheses, sessions, evaluation]
---

# Evaluate agent-intent hypotheses from session sequences with jeq

## Problem
Existing Jev experiments classify repair rules or policy categories, not the agent's original intent. To use probabilistic repair safely, code must generate explicit competing intent hypotheses from pre-failure session evidence, ask Jev which hypothesis best explains the observation, and score it against hidden future behavior.

## Desired outcome
A session-derived evaluation that tells us whether Jev can identify original intent from bounded prior context—not whether it can repeat error-to-rule mappings.

## Method

1. Extract a bounded local episode: up to 3 prior messages/tool calls, the failed call and error, and up to 3 following messages/tool calls.
2. A reviewer uses the full local episode to label the original intent or `unresolvable`; future behavior is evidence, not an automatic label.
3. Hide all post-failure events and reviewer labels from Jev.
4. Deterministic code generates 2–4 mutually exclusive, case-specific intent hypotheses plus `uncertain` using pre-failure evidence only.
5. Send Jev only bounded redacted pre-failure context, attempted tool shape, failure class, and hypotheses. Full episode content stays local.
6. `jeq` Choice estimates the probability distribution and confidence over those hypotheses.
7. Code—not Jev—maps a supported hypothesis to a repair candidate and applies policy.

## Acceptance criteria
- [ ] At least 30 independently reviewed cases, stratified across missing reads, ambiguous edits, edit mismatch/drift, and invalid tool shapes, with duplicate-session concentration reported.
- [ ] Local review worksheet includes the bounded prior/failure/following episode and reviewer label; it remains in ignored `.tmp` artifacts.
- [ ] Jev state contains only pre-failure evidence: attempted tool, argument-key/type shape, failure class, bounded prior tool names/outcomes, and at most 512 redacted characters of planning context. No future-action or reviewer-label leakage.
- [ ] Hypotheses are explicit causal claims about intent, not repair-rule names or policy decisions.
- [ ] Ground truth is a reviewer judgment over both prior context and the next 2–3 calls/messages; later behavior alone never mints a label automatically.
- [ ] Requests contain no paths, source, commands, edit text, credentials, future conversation, or unredacted planning text.
- [ ] Use installed `jeq` CLI, zero retries, Choice probabilities preserved; unknown/malformed responses fail closed.
- [ ] Report top-1 accuracy, calibration by confidence bucket, abstention/uncertain behavior, precision at confidence >=0.99, and results per failure family.
- [ ] No runtime integration or auto-repair in this task.

## Non-goals
- Asking Jev which policy or repair rule to execute.
- Generating repairs, paths, commands, or content.
- Treating future actions as input evidence.
