---
id: TASK-0030
title: Mine bounded failure-and-recovery episodes from sessions
status: doing
depends_on: []
priority: high
tags: [mining, sessions, intent, recovery, evidence]
---

# Mine bounded failure-and-recovery episodes from sessions

## Problem
Failure mining currently aggregates isolated errors, so it cannot reveal what the agent intended or how it recovered. We need bounded session episodes around each failure—prior context, the failed call/error, and the next actions—before designing probabilistic repairs or Jev hypotheses.

## Desired outcome
A local episode dataset and report showing common intent/recovery patterns around real failures. This becomes the evidence base for later probabilistic-repair experiments; no model call or runtime change occurs here.

## Episode window

- Up to 3 preceding user/assistant/tool events.
- Failed tool call plus its tool result/error.
- Up to 3 following user/assistant/tool events.
- Preserve ordering, session ID, opaque call IDs, timestamps, tool names, result status, and structural argument keys/types.
- Full message/tool content may exist only in ignored local review artifacts; reports contain redacted summaries and metadata.

## Acceptance criteria
- [ ] Deterministically extract bounded episodes from `~/.pi/agent/sessions/`; same corpus produces byte-identical index/report.
- [ ] Report counts by failed tool/error family and recovery shape: same-tool retry, different-tool recovery, user intervention, unrelated continuation, abandonment, unresolved.
- [ ] Detect bounded linkage signals without claiming intent: same path locally, locator extension, repeated tool shape, next successful call, and intervening unrelated events.
- [ ] Produce a local review worksheet for assigning `apparent-intent`, `recovery-related` (yes/no/uncertain), `recovery-strategy`, and `probabilistic-repair-candidate` (yes/no/uncertain).
- [ ] Stratified sample across top structural families, with duplicate-session concentration reported instead of silently over-sampling long sessions.
- [ ] No Jev/LLM/API calls; no runtime behavior changes.
- [ ] Shared report contains no paths, commands, source, edit text, credentials, or conversation text.
- [ ] Tests cover episode boundaries, intervening user messages, unrelated next calls, abandonment/end-of-session, deterministic ordering, and report privacy.

## Non-goals
- Automatically labeling original intent.
- Designing prompts or hypotheses.
- Promoting any probabilistic repair.
