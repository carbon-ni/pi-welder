---
id: TASK-0039
title: Enable probabilistic missing-read path repair and separate diagnostics
status: doing
depends_on: [TASK-0022]
priority: high
tags: [read, jev, auto-repair, diagnostics, stats]
---

# Enable probabilistic missing-read path repair and separate diagnostics

## Problem
`missing-read-context` appends useful directory context but does not repair the failed read, yet current stats count it as a repair. The existing bounded Jev read-path selector is shadow-only despite an explicit opt-in setting.

## Desired outcome
When `readPathRepairEnabled` is on and TypeSafe is available, missing relative read paths get bounded filename/folder candidates. Jev may select one at confidence >=0.90; code revalidates it and replaces only `read.path`. Otherwise the normal missing-path failure remains and may receive diagnostic context. Stats separate actual repairs, verified recoveries, and diagnostic enrichments.

## Acceptance criteria
- [ ] `readPathRepairEnabled` explicitly enables runtime mutation; remove the frozen evidence verdict as an additional hidden gate while retaining the documented historical evidence.
- [ ] Only missing, contained relative paths are eligible; existing paths, directories, absolute/traversal paths, malformed calls, and non-read tools make no request.
- [ ] Generate at most five readable regular-file candidates based on basename and directory similarity under cwd.
- [ ] Jev receives requested relative path and candidate relative paths only; one request, zero retries, two-second timeout.
- [ ] Known candidate at confidence >=0.90 is revalidated for containment/readability immediately before replacing `read.path`; tool then performs the actual read.
- [ ] Abstain, low confidence, malformed, unavailable, timeout, rate limit, missing API key, or failed postcheck leaves the original path unchanged.
- [ ] UI/audit transparently records `restore-read-path` without persisting paths or file contents.
- [ ] `missing-read-context` remains `isError: true` but is counted and displayed as diagnostic enrichment, not a repair or repaired call.
- [ ] `edit-noop` is displayed separately as a verified result recovery; input transformations and routed calls remain repairs.
- [ ] Real AgentSession tests cover selected path read, abstention fallback, postcheck failure, disabled/no-key paths, and privacy-safe telemetry.

## Known risk
The frozen TASK-0022 probe selected 5 of 7 targets correctly and 2 incorrectly. This task enables the behavior by explicit owner opt-in, not because that evidence gate passed. The confidence threshold, candidate bound, abstention, and post-validation remain mandatory.
