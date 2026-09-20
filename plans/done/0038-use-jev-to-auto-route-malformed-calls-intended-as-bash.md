---
id: TASK-0038
title: Use Jev to auto-route malformed calls intended as Bash
status: done
depends_on: [TASK-0034]
priority: high
tags: [jev, bash, routing, auto-repair, typesafe]
---

# Use Jev to auto-route malformed calls intended as Bash

## Problem
The previous label-collection and generic target-mapping direction did not match the requested behavior. For a bounded malformed read/write/edit call, ask the existing TypeSafe Jev integration directly whether the supplied value is intended as a Bash command. A positive answer auto-routes the unchanged value through Pi's Bash tool; a negative, uncertain, unavailable, or malformed answer preserves failure.

## Desired outcome
For a non-exact call with one plausible string payload, Jev answers the direct closed question “Is this intended as a Bash command?” If yes, pi-welder routes that unchanged value through Pi's normal Bash tool. Otherwise it does not repair.

## Acceptance criteria
- [ ] Exact canonical `{command: string, timeout?: number}` calls retain TASK-0034 deterministic routing and do not call Jev.
- [ ] Non-exact `read`/`write`/`edit` calls are eligible only when they contain exactly one bounded non-empty string payload under an arbitrary safe key, plus at most a valid canonical `timeout`.
- [ ] Add a dedicated typed Jev client contract and prompt for `bash` versus `not-bash`; do not reuse or cast the edit-selection client.
- [ ] The Jev request contains attempted tool, original safe key, and the original candidate string because semantic command classification requires its content. It contains no conversation, source files, results, environment, credentials, or future behavior.
- [ ] A valid `bash` answer routes the original string unchanged through Pi's Bash delegate, with the original valid timeout when present.
- [ ] `not-bash`, malformed response, timeout, cancellation, rate limit, missing API key, untrusted project, disabled setting, oversized payload, unsafe key, or ambiguous/multiple payloads never execute Bash.
- [ ] The async judgment is bounded, zero-retry, single-use, epoch-invalidated, byte/count bounded, and rechecks live setting/trust immediately before execution.
- [ ] UI and audit state that Jev classified and routed the source tool to Bash without logging or rendering command content.
- [ ] Remove the mistaken prospective-label runtime/config/settings feature and unused generic tool-mapping prototype/eval code introduced by TASK-0036/0037.
- [ ] Real AgentSession tests cover exact/no-Jev, arbitrary alias yes→Bash, no→failure, unavailable/malformed/timeout→failure, and disabled/untrusted paths.

## Non-goals
- Predicting arbitrary target tools.
- Collecting labels before asking Jev.
- Letting Jev generate, rewrite, or choose command text.
- Silently dropping extra arguments.
