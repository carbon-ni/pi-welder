---
id: TASK-0035
title: Add probabilistic shadow judge for non-exact tool routing
status: done
depends_on: [TASK-0033, TASK-0034]
priority: high
tags: [routing, aliases, jev, shadow, commands, evidence]
---

# Add probabilistic shadow judge for non-exact tool routing

## Problem
Exact wrong-tool schema matches now route deterministically, but non-exact malformed calls still lack the requested probabilistic fallback. The command field may be named `CMD`, `bash`, `execute`, or an arbitrary key. We need bounded deterministic mapping hypotheses, a privacy-safe Jev judgment, and correlated recovery labels before probabilistic execution can be calibrated.

## Desired outcome
A shadow-only judge that evaluates whether one existing string field was intended as `bash.command`. It records probabilities and later recovery outcomes without mutating arguments or executing commands.

## Method

1. Observe Pi validation failures for non-bash tools that were not handled by exact routing.
2. Enumerate at most five top-level non-empty string fields as candidate command mappings; preserve each value verbatim locally.
3. Permit only explainable supporting fields such as a valid canonical timeout. Multiple unexplained content fields force `none`/abstention.
4. Build privacy-safe features for each value: length/token/line buckets, executable-like leading token, shell operator/redirection flags, assignment flag, and path/prose shape. Never send the raw value.
5. Add bounded closed intent signals from up to three prior events.
6. Ask Jev which mapping hypothesis best explains intent: candidate ordinal or `none`.
7. Correlate with a successful bounded later tool call locally; future behavior never enters the request.

## Acceptance criteria
- [ ] Candidate keys may be canonical, case variants, known aliases, or arbitrary safe identifiers; no fixed alias list is required for enumeration.
- [ ] At most five candidate string fields plus `none`; invalid keys, oversized values, nested objects, arrays, and unexplained extra content fail closed.
- [ ] Candidate values are never changed, generated, executed, logged, or transmitted.
- [ ] Requests contain only safe key tokens, closed derived value features, attempted tool, candidate ordinals, and bounded prior intent signals; no raw commands, paths, source, credentials, conversation, or future behavior.
- [ ] Use installed `jeq`, zero retries, hardened Choice parsing, and record per-hypothesis probabilities/confidence.
- [ ] Report historical labelability, accuracy/calibration/abstention, precision and coverage at >=0.90 and >=0.99, and deterministic alias/baseline comparisons.
- [ ] Runtime integration is shadow-only: original calls fail normally and no command executes.
- [ ] Future execution promotion requires at least 30 threshold selections with zero wrong, candidate coverage >=0.95 for the eligible population, and deterministic post-validation of the selected mapping.

## Non-goals
- Assuming any string is safe to execute.
- Sending raw command content to Jev.
- Dropping unexplained arguments.
- Enabling probabilistic execution before calibration.
