---
id: TASK-0019
title: Shadow-select ambiguous edit candidates with Jev
status: doing
depends_on: []
priority: high
tags: [edit, typesafe, shadow, safety, privacy]
---

# Shadow-select ambiguous edit candidates with Jev

## Problem
When deterministic edit preflight finds several exact viable targets, pi-welder must currently abstain without learning which target was intended. We need bounded real-world evidence before any semantic selector can safely influence edits.

## Desired outcome

Collect trustworthy labels about whether a bounded Jev choice could resolve ambiguous exact edit targets, without changing, delaying, or blocking any tool call. The resulting evidence must support an explicit promote-or-reject decision later.

## Context

This continues TASK-0013, which defined ordinal-or-abstain selection but found too few real held-out cases for runtime use. Decision record: `/Users/cristianoliveira/.agents/reports/17-09-26/jev-welder-decision-record.md`.

An eligible case has 2–5 exact `oldText` candidates after the filesystem is read successfully and deterministic disambiguation cannot prove one target. Jev may see only capped candidate windows and the requested edit text. It may return one candidate ordinal or abstain. Its answer is advisory data only.

TypeSafe states that it does not train on API Input, but standard retention has no fixed duration. Source transmission therefore requires explicit opt-in despite API-key presence. Zero-data retention is available separately to enterprise customers.

## Acceptance criteria

### Product behavior

- [ ] Source shadowing is disabled by default and requires an explicit persisted setting plus `TYPESAFE_API_KEY`.
- [ ] Settings or diagnostics clearly show whether source shadowing is enabled and that bounded repository source leaves the machine.
- [ ] Only proven ambiguous cases with 2–5 exact candidates are eligible; clean, unique, unreadable, over-limit, or deterministically resolved edits make no request.
- [ ] The original edit call proceeds unchanged and does not await Jev.
- [ ] Jev can return only a known candidate ordinal or abstain. Unknown, malformed, or low-confidence output is an abstention.
- [ ] No Jev answer mutates tool input, tool result, files, paths, `oldText`, or `newText` in this task.

### Privacy and resource limits

- [ ] Candidate windows are credential-redacted and capped at 20 lines and 2 KiB each, with at most 5 candidates and 12 KiB total serialized state.
- [ ] Sanitization loss, payload overflow, missing configuration, exhausted budget, timeout, transport failure, cancellation, or rate limiting fails closed to current behavior.
- [ ] Shadow requests are capped at 10 per session, concurrency 1, timeout 2 seconds, and zero retries.
- [ ] Source windows, edit text, paths, credentials, and full request/response payloads never enter welder logs.
- [ ] Persisted evidence contains only candidate count, selected ordinal/abstention, confidence, latency, returned model version, terminal status/error class, and outcome-label status.

### Evidence and lifecycle

- [ ] A later successful edit provides a provisional label only when it uniquely maps to one prior candidate within a documented bounded episode.
- [ ] Unresolved cases remain unlabeled and are excluded from precision.
- [ ] In-flight requests are tracked and aborted on session shutdown; shutdown has a small fixed grace bound and never waits indefinitely.
- [ ] The TypeSafe client is an injected infrastructure capability; deterministic edit logic and tests do not import the SDK.
- [ ] Tests cover opt-in/off, strict eligibility, valid choice, abstention, low confidence, malformed output, timeout, cancellation, rate limit, sanitization failure, payload/request caps, concurrency, no payload logging, correlation, and unchanged tool input.
- [ ] A real-model smoke test is opt-in and writes only ignored local artifacts.

## Promotion boundary

Automatic edit selection is explicitly out of scope. A later task may consider it only after at least 30 real held-out manually reviewed labels, a predeclared confidence threshold, precision at that threshold of at least 0.99, zero wrong-target or hard-safety violations, deterministic postchecks, acceptable latency/failure rates, and explicit owner approval.

## Non-goals

- Generate replacement text, paths, commands, code, or recovery messages.
- Add generic error guidance.
- Use Jev for clean, unique, or deterministically repairable edits.
- Run a parallel transparency, field-classification, or failure-mining experiment.
- Persist source payloads for replay or debugging.

## Sources

- `plans/contracts/dspy-optimization-contract.md`
- `plans/done/0013-evaluate-bounded-ambiguous-edit-candidate-selection.md`
- https://docs.typesafe.ai/sdk/javascript.md
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/legal.md
- https://typesafe.ai/legal/privacy-policy
- https://typesafe.ai/legal/data-processing

