---
id: TASK-0024
title: Bootstrap shadow labels by offline replay of historical ambiguous edits
status: doing
depends_on: [TASK-0019]
priority: high
tags: [edit, typesafe, shadow, evidence, replay, promotion]
---

# Bootstrap shadow labels by offline replay of historical ambiguous edits

## Problem
TASK-0020 needs at least 30 reviewed labels to reach a promote-or-reject verdict, but live accrual is starved: zero eligible ambiguous edits since enabling. The corpus already holds 916 ambiguous-edit failures whose sessions contain the agent's eventual successful edit — retrospective ground truth. We can fill the evidence gate from history instead of waiting weeks.

## Desired outcome
A reviewed label set built by replaying historical ambiguous-edit windows through Jev offline, scored against what the agent actually did, feeding TASK-0020's promotion decision.

## Predeclared method (fixed)

- **Pair extraction:** from session logs, an ambiguous `edit` failure (2–5 exact occurrences reported) followed by a successful `edit` on the same path in the same session whose `oldText` extends the failed `oldText` (contains it) and resolves to exactly one occurrence.
- **Validity filter (honest about drift):** re-run the pair against *current* file content through the existing `buildAmbiguousShadowRequest` pipeline. Keep only pairs where the failed `oldText` still yields 2–5 matches today and the successful `oldText` still resolves uniquely today. Labels are valid for current content; this is disclosed, not hidden.
- **Replay:** send the bounded, redacted, containment-checked windows through the existing `JevClient` — byte-identical pipeline to live shadowing. Zero retries, 2-second timeout, sequential, capped at 200 API calls total.
- **Scoring:** attempted selection = ordinal present with confidence ≥ 0.9 (TASK-0020 protocol). Wrong-target = selected ordinal ≠ ground-truth occurrence. Historical ground truth prefills a `historical-target` column; a human reviewer confirms each row into `verified-target` before any metric counts.

## Acceptance criteria

### Extraction and validity
- [ ] Pair miner deterministic: same corpus → identical pairs, byte-identical worksheet.
- [ ] Pairs carry session id, both toolCallIds, timestamps, failed/successful oldText lengths (not contents), and occurrence counts.
- [ ] Validity filter reuses `buildAmbiguousShadowRequest` — no reimplementation of caps, redaction, or containment.

### Replay
- [ ] Replay output uses the closed metadata schema; no source, paths, or edit text in any artifact outside the in-memory request.
- [ ] Budget enforced: ≤200 calls, sequential, 2s timeout, zero retries; aborted requests recorded as failures, never retried.
- [ ] Latency, model, and status per call logged.

### Review and verdict
- [ ] Worksheet extends the existing shadow-labels format with `historical-target`; metrics unchanged (0.9 threshold, ≥30 gate, wrong-target hard block, unresolvable excluded).
- [ ] Either ≥30 reviewed labels or an explicit insufficient-data verdict with the filter's attrition numbers.
- [ ] Report feeds TASK-0020's promote/reject/extend decision; runtime stays advisory throughout.

## Non-goals
- Any runtime behavior change.
- Synthetic or guessed ground truth — unconfirmed rows never count.
- Re-running failed API calls.
