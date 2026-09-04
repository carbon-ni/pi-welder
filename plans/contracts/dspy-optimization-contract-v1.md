---
id: dspy-optimization-contract
version: 1
status: accepted
created: 2026-09-04
supersedes: none
applies_to: [TASK-0009, TASK-0010, TASK-0011, TASK-0012, TASK-0013, TASK-0014]
---

# DSPy optimization contract and safety gates (v1)

## 1. Purpose and scope

This contract fixes, before any optimizer runs, how pi-welder guidance/repair candidates are scored, compared, and adopted. It binds every offline optimization task (TASK-0009..0014). Optimizers search only over guidance-message text and selection among already-implemented repair actions. They never generate new repair logic, never run inside the Pi extension runtime, and never touch content fields.

Non-negotiable product rule carried into this contract: **no generic recovery messages**. A candidate message must describe an actual deterministic repair or add factual, action-specific context about the concrete failure. If no candidate beats the no-message baseline, the winner is "no message" and that is a valid published outcome.

## 2. Definitions

- **Event**: a `WelderEvent` record (`src/recorder/events.ts`): `ts`, `eventType`, `toolName`, `provider`, `model`, `repairs[]`, `wasRepaired`, `inputKeys[]`, `wasError`, `errorKind`, `errorText` (bounded 500 chars). Pi-native session JSONL provides the tool call arguments and result pairing via `pi-session-source.ts`.
- **Episode**: one failed tool call plus its following same-tool retry chain (up to 5 subsequent calls or the next different-tool call) within one session, with a stable `episodeId = <sessionId>#<line>` of the failing call.
- **Candidate**: a pure function `guidance(event) -> message | null`, evaluated offline. `null` means no message. Candidates are versioned text templates with slot values taken only from the event (tool name, `errorKind`, repair action names, field paths, bounded `errorText` excerpt).
- **Policy**: the candidate under test; applying a policy to an episode means replaying the recorded next tool call after prepending the candidate message to the retry context.

## 3. Data source and eligibility

Corpus: all local `.pi/welder-log/*.jsonl` session logs plus Pi-native session JSONL, mined with the existing pi-welder-mine workflow. Reference snapshot `.pi/welder-log/failures-report.md` (2026-09-04T19:45:03Z): **176 clusters, 23,378 failures**; largest actionable structurals: `bash/TOOL_ERROR ×11572`, `bash/SCHEMA ×3025`, `bash/ENOENT ×1347`, `edit/TOOL_ERROR ×1220`, `read/ENOENT ×1105`, `edit/EDIT_NOT_UNIQUE ×772`, `edit/EDIT_NOT_FOUND ×628`.

An episode is **eligible** iff:

1. The failed call has at least one subsequent same-tool retry recorded (paired evidence, same rule as TASK-0002/0003 mining).
2. `errorKind` is one of the in-scope kinds for the candidate's target cluster (declared per candidate; v1 scope: `EDIT_INVALID_SHAPE`, `EDIT_NOT_UNIQUE`, `EDIT_NOT_FOUND`, `EDIT_OVERLAP`, `EDIT_EMPTY_ANCHOR`, `EDIT_MISMATCH`, `SCHEMA`, `ENOENT`).
3. The payload passes dedupe: episodes with identical normalized `(toolName, errorKind, sorted inputKeys, sha256 of sanitized arguments)` collapse to one unit, weighted by occurrence count.

Excluded: `bash/RUN`, `bash/TOOL_ERROR` and other execution-outcome clusters **unless** the candidate targets a declared structural sub-signal; excluded clusters are reported per run as "out of scope: N episodes".

## 4. Metrics (computable, in evaluation order)

All metrics derive only from recorded fields (Section 2) plus deterministic replay checks. Derivation scripts must run with `node --experimental-strip-types` and no network.

### 4.1 Primary outcome

**FRV — First-Retry-Valid rate** = eligible episodes where the first post-guidance retry call is *valid* ÷ all eligible episodes.

*Valid* means, checked offline in order: (a) passes JSON-Schema shape validation for the tool as encoded in `src/schemas.ts` fixtures; (b) passes welder preflight checks (`merge-edit-anchor`/no-op/overlap detection would not fire); (c) would not be repaired (`repairs[]` empty on the replayed call). A repaired-but-then-successful call does **not** count as FRV success — this prevents rewarding calls that get silently fixed.

### 4.2 Secondary outcome (gate, not ranking)

**REC — Recurrence rate** = episodes where a call with the same `(toolName, errorKind)` recurs within the next 3 calls of the episode ÷ all eligible episodes. REC must not regress (Section 8).

### 4.3 Cost metrics (reported, not gated except CC)

- **CC — Calls-to-clean**: mean number of retry calls in the episode until the first valid call (cap 5; episodes that never reach valid count as 5).
- **GM — Guidance mass**: candidate message characters (offline deterministic proxy) and tokens when a runtime phase runs; reported as median and p95.
- **TC — Token cost**: actual LM tokens consumed by optimization, from optimizer run logs, per candidate and total.

Latency is not computable offline from recorded logs; it is optional in a runtime phase and never a gate in v1.

## 5. Hard safety invariants (zero-tolerance gates)

A candidate that violates any invariant is **disqualified regardless of score**; the run records `DISQUALIFIED: <invariant>`. Semantic mutation is a hard failure, never a weighted tradeoff.

1. **Content invariance**: for every replayed retry call, values of `command`, `code`, `content`, `write.content`, `edits[].oldText`, `edits[].newText`, `oldText`, `newText` are byte-identical to the recorded retry arguments.
2. **Path invariance**: `path`, `filePath`, and any `*path` argument value is byte-identical to the recorded retry arguments.
3. **No repair invention**: the candidate may reference only repair actions present in the current `repairs[]` action registry (`src/repairs/types.ts` union) and only for the tool/`errorKind` cluster it declares.
4. **No content echoing**: the candidate message may quote at most 120 chars of `errorText` and no other content.
5. **Determinism**: `guidance(event)` is pure; same event → same message, no clock, no randomness, no network.

## 6. Message gates (anti-generic)

A candidate message is rejected unless **all** hold:

1. It names the concrete `toolName` and `errorKind` of the triggering event.
2. It contains at least one action-specific token: a repair action name (e.g. `rename-edit-item-alias`), a field path (e.g. `edits[0].newText`), or a declared next-action verb from the cluster's factual playbook (e.g. "provide `oldText` matching exactly once").
3. It does not match any message removed by plans/done/0018 (regression set maintained in the lab fixtures) and does not match the generic pattern `/(let'?s|please) (try|retry|check|fix|adjust)/i` in a sentence that contains no field path or action name.
4. Length ≤ 480 characters.

Baselines B0/B1 and any candidate are scored through the identical gate; a candidate may never win by being vaguer than B1.

## 7. Leakage-safe splits

- Unit of splitting: **session** (one `sessionId` / one log file). All episodes of a session live in exactly one split.
- Order sessions by first-event `ts`; assign contiguous blocks: **train 60% / development 20% / holdout 20%** by session count (ties by `sessionId` lexical order; no randomness).
- Dedupe groups (Section 3.3) are atomic: a group belongs to the split of its earliest occurrence; later duplicate occurrences contribute only weight to that split.
- **Holdout is sealed**: it is not read, queried, or reported until the final adoption report; dev-set numbers are labeled `dev` in every intermediate artifact.
- Splits are frozen per contract version and recorded (session id list + counts) in the run artifact.

## 8. Fixed experiment parameters

| Parameter | Value |
| --- | --- |
| Contract seed | `20260904` (all optimizer sampling; recorded in every artifact) |
| Optimizer LM | `openrouter/google/gemini-2.5-flash` (pinned at run date; record response `model` string echoed by provider) |
| Evaluator | deterministic code (Sections 4–7); **no LLM judge** in v1 |
| Temperature | optimizer 1.0; any sampling run 0 |
| LM call budget | ≤ 600 total per optimization run; ≤ 200 per candidate |
| Per-call timeout | 120 s |
| Retries | 2 per failed LM call, backoff 2 s then 8 s; abort run after 3 consecutive failures |
| Concurrency | ≤ 4 in-flight LM calls |
| Artifacts | written only to git-ignored paths (`.tmp/`, `.local/`); nothing under `src/` |

Any change to this table is a contract version bump.

## 9. Baselines

- **B0 no-message**: repairs and preflight as shipped; `guidance(event) -> null`.
- **B1 current guidance**: recovery guidance and repair warnings exactly as shipped (`src/recovery.ts`, `src/repair-warnings.ts`).
- Generic recovery guidance (removed in plans/done/0018) is **excluded** from the candidate space and from baselines; it exists only inside the Section 6 rejection fixtures.

## 10. Go / no-go thresholds (on sealed holdout)

GO requires **all** of:

1. FRV(candidate) ≥ FRV(best baseline) + **5 percentage points** absolute, with per-cluster minimum of 30 eligible episodes.
2. Hard invariants: **zero** violations.
3. REC(candidate) ≤ REC(best baseline) + **1 percentage point**.
4. CC(candidate) ≤ CC(best baseline) + **0.1** calls.
5. GM p95 ≤ 480 chars (gate 6.4 holds by construction, re-verified).

**NO-GO / no-message winner**: if no candidate clears thresholds against **B0**, the published outcome is "no-message wins for these clusters"; record negative result, keep B0. If a candidate clears thresholds vs B0 but not vs B1, outcome is "keep B1" (no runtime change).

## 11. Offline / runtime boundary

- **Offline (Welder Lab)**: mining, splits, candidates, optimizer, scoring. Separate process; no imports from `src/index.ts` runtime path; DSPy.ts (TASK-0009) lives outside the extension and may become at most a devDependency of the lab, never of pi-welder.
- **Runtime**: only a winning message set is promoted, delivered through the existing recovery/warnings path with factual context; promotion requires a separate reviewed task (TASK-0014 style), owner approval, and the holdout report attached. The runtime never imports the optimizer, never calls an LM, and fails closed: delivery failures never block tool execution.

## 12. Deterministic review checklist (no doc-schema tooling exists in-repo)

1. Every Section 4 metric derivation references only fields named in Section 2.
2. No holdout number appears outside the final adoption report.
3. Section 8 table has no TBD/placeholder values.
4. Baselines B0 and B1 present; no generic-guidance baseline.
5. Section 5 lists content, path, and replacement fields by name.
6. Version history table below is updated on any change.
7. `rg -n "let's try|please retry|generic" plans/contracts/` returns no candidate text matches outside Section 6 fixtures reference.

## 13. Version history

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-04 | Initial contract: FRV primary, REC/CC/GM/TC metrics, hard invariants, session-time splits, fixed params, B0/B1 baselines, go/no-go, offline/runtime boundary. |
