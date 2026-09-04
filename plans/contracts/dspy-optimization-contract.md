---
id: dspy-optimization-contract
version: 2
status: accepted
created: 2026-09-04
supersedes: dspy-optimization-contract v1
applies_to: [TASK-0009, TASK-0010, TASK-0011, TASK-0012, TASK-0013, TASK-0014]
---

# DSPy optimization contract and safety gates (v2)

## 0. v2 changes over v1

1. Candidate space narrowed to two shipped message domains only: repair transparency and factual result enrichment. Events without applied repairs are **structurally outside the domain** (producing a message for them is an automatic disqualification), not merely a named exclusion.
2. Baseline B1 corrected: shipped behavior is repair warnings plus result-repair enrichment. `src/recovery.ts` is explicit diagnostics only since plans/done/0018 and is out of candidate scope, out of baselines, and never a promotion path.
3. Runtime promotion corrected: winners promote through the repair-warnings delivery or the result-repair patch path only.
4. Metrics restructured into two populations: FRV was not meaningful for repair warnings accompanying already-repaired calls; those episodes now use NRR (non-recurrence of the same repair).

## 1. Purpose and scope

This contract fixes, before any optimizer runs, how pi-welder message candidates are scored, compared, and adopted. It binds every offline optimization task (TASK-0009..0014). Optimizers search only over message text for the two shipped domains below. They never generate new repair logic, never run inside the Pi extension runtime, and never touch content fields.

Non-negotiable product rule carried into this contract: **no generic failure/error guidance**. Eligible messages are only:

- **(a) Repair transparency**: a message describing a deterministic repair that actually occurred on that call, naming its action(s) and field(s).
- **(b) Factual result enrichment**: a message stating facts of a deterministic result-repair patch that was actually applied (rule name plus what the patch factually changed).

If no candidate beats the no-message baseline, the winner is "no message" and that is a valid published outcome.

## 2. Runtime ground truth (post-TASK-0018)

- **Input repairs** (`src/repairs/`): applied to `tool_call` input before execution.
- **Result repairs** (`src/result-repairs/`): deterministic patches to tool results (`directory-read`, `read-offset-context`, `missing-read-context`, `edit-noop`), returned via `handleToolResult`.
- **Repair warnings** (`src/repair-warnings.ts`): transparency hints for applied repairs, delivered as a system message on the next context (`consumeRepairWarnings`).
- **Recovery** (`src/recovery.ts`): failure records for stats and explicit diagnostic commands only (`/welder-failures`). It does **not** deliver anything to the model automatically.

## 3. Definitions

- **Event**: a `WelderEvent` record (`src/recorder/events.ts`): `ts`, `eventType`, `toolName`, `provider`, `model`, `repairs[]` (action names), `wasRepaired`, `inputKeys[]`, `wasError`, `errorKind`, `errorText` (bounded 500 chars). Pi-native session JSONL provides call/result pairing via `pi-session-source.ts`.
- **Candidate**: a pure function `guidance(event, repairs) -> message | null`. `repairs` is the resolved `(field, action)[]` for the event, recovered offline by re-running the shipped repair engines on the recorded arguments (deterministic; the log stores action names only, fields are re-derived). The function's **domain is repair-bearing events only**: `repairs.length === 0` must yield `null`. A message returned for a repair-free event is a structural violation.
- **Policy**: one candidate; applying it means replaying the episode with the candidate message attached through its declared delivery path (Section 10).

## 4. Candidate domains (closed set)

1. **Repair transparency (P1 population)**: triggered by an event with `repairs.length > 0`. The message may reference only `(action, field)` pairs present in `repairs`, using only the shipped registry actions (`src/repairs/types.ts`: `strip-null` … `resolve-ambiguous-edit`, 21 actions) and, for action hints, only the shipped hint text or a rephrasing of it.
2. **Factual result enrichment (P2 population)**: triggered by an applied result-repair patch. The message may state only: the rule name, the factual patch effect (e.g. lines available, requested offset, files listed), and the concrete next input fact it implies. No advice beyond the patch's facts.

Anything else — including any message keyed to `errorKind` without an accompanying repair, motivational text, apologies, or next-step suggestions not implied by an applied repair — is outside the domain and cannot be expressed by `guidance` at all.

## 5. Data source and eligibility

Corpus: all local `.pi/welder-log/*.jsonl` session logs plus Pi-native session JSONL, mined with the existing pi-welder-mine workflow. Reference snapshot `.pi/welder-log/failures-report.md` (2026-09-04T19:45:03Z): 176 clusters, 23,378 failures — used for **mining context only**; eligibility is repair-based, not failure-based.

- **P1 episode**: seeded by a call event with `wasRepaired: true`, plus the next 3 same-tool calls in the same session (or fewer if the session ends). Eligible iff the re-derived `repairs` is non-empty.
- **P2 episode**: seeded by a failed call with at least one subsequent same-tool retry **where the retry (or the failed result itself) carries an applied result-repair patch**. Eligible iff the paired repair record exists.
- Dedupe: episodes with identical normalized `(toolName, sorted repairs, sha256 of sanitized arguments)` collapse to one unit, weighted by occurrence count.

## 6. Metrics (computable, in evaluation order)

All metrics derive only from recorded fields (Section 3) plus deterministic replay of the shipped repair engines. Scripts run with `node --experimental-strip-types`, no network, no LM judge.

### 6.1 Primary outcomes

- **P1 primary — NRR (Non-Repair-Recurrence rate)**: share of P1 episodes where no call within the episode window incurs the same `(toolName, action)` repair again. *Why NRR and not FRV*: the seeded call was already invalid-then-repaired — it is valid by construction after the repair, so "first retry valid" is vacuous here; the meaningful outcome is whether the transparency message stops the model from repeating the same structural mistake.
- **P2 primary — FRV (First-Retry-Valid rate)**: share of P2 episodes where the first post-message retry call is *valid*: (a) passes schema shape validation as encoded in `src/schemas.ts` fixtures; (b) passes welder preflight checks; (c) requires no input repair (`repairs[]` empty on replay). A repaired-but-successful retry does not count — rewarding silently fixed calls is forbidden.

A candidate declares exactly one population; it is scored only there.

### 6.2 Secondary gate

**REC (P2 only)**: share of P2 episodes where a call with the same `(toolName, errorKind)` recurs within the next 3 calls. Must not regress (Section 9). P1 recurrence is the P1 primary itself and is not double-counted.

### 6.3 Cost metrics (reported; CC gated)

- **CC — Calls-to-clean**: P1: mean calls in window until no new repair occurs (cap 3); P2: mean retries until first valid call (cap 5; never-valid counts as cap).
- **GM — Guidance mass**: message characters offline (median, p95); tokens when a runtime phase runs.
- **TC — Token cost**: optimizer LM tokens from run logs, per candidate and total.

Latency is not computable offline; optional in a runtime phase; never a v1 gate.

## 7. Hard safety invariants (zero-tolerance gates)

A candidate violating any invariant is disqualified regardless of score (`DISQUALIFIED: <invariant>`):

1. **Content invariance**: replayed call/result values of `command`, `code`, `content`, `write.content`, `edits[].oldText`, `edits[].newText`, `oldText`, `newText` are byte-identical to the recorded values.
2. **Path invariance**: `path`, `filePath`, and any `*path` argument value is byte-identical to the recorded value.
3. **No repair invention**: messages may reference only actions present in the shipped registries and only pairs actually derived for that event.
4. **No content echoing**: at most 120 chars of `errorText`; no other content quoting.
5. **Domain closure**: `guidance` returns `null` for every repair-free event in the corpus sample (checked mechanically over a fixed 1,000-event sample; one miss disqualifies).
6. **Determinism**: pure function; same inputs → same message; no clock, randomness, or network.

## 8. Baselines

- **B0 no-message**: repairs and result-repair patches as shipped; `guidance -> null` everywhere.
- **B1 shipped transparency**: repair warnings exactly as shipped (`repair-warnings.ts` HINT_MAP text via `consumeRepairWarnings`) plus result enrichment exactly as shipped (result-repair patch contents).
- `recovery.ts` behavior is **not** a baseline: it is explicit diagnostics only and never reaches the model automatically. Generic failure/error guidance (removed in plans/done/0018) exists only as rejection fixtures in the lab, never as a baseline or candidate.

## 9. Go / no-go thresholds (on sealed holdout)

GO requires **all** of, for the candidate's declared population:

1. Primary (NRR for P1, FRV for P2) ≥ best baseline + **5 percentage points** absolute, with ≥ 30 eligible episodes per population-cluster.
2. Hard invariants: **zero** violations (including domain-closure sampling).
3. REC (P2) ≤ best baseline + **1 percentage point**.
4. CC ≤ best baseline + **0.1** calls.
5. GM p95 ≤ 480 characters.

**NO-GO / no-message winner**: no candidate clears thresholds vs **B0** → publish "no-message wins for this population"; record the negative result; keep B0. A candidate beating B0 but not B1 → keep B1 (no runtime change).

## 10. Offline / runtime boundary

- **Offline (Welder Lab)**: mining, population construction, candidates, optimizer, scoring. Separate process; no imports from `src/index.ts`; DSPy.ts (TASK-0009) stays outside the extension and at most a lab devDependency.
- **Runtime promotion**: a winning message set is promoted **only** through shipped model-facing paths: the repair-warnings delivery (`consumeRepairWarnings` system message) or the result-repair patch path (`handleToolResult` return). There is no recovery delivery path; recovery stays diagnostics-only. Promotion requires a separate reviewed task (TASK-0014 style), owner approval, and the sealed holdout report. The runtime never imports the optimizer, never calls an LM, and fails closed: delivery failures never block tool execution.

## 11. Fixed experiment parameters

| Parameter | Value |
| --- | --- |
| Contract seed | `20260904` (recorded in every artifact) |
| Optimizer LM | `openrouter/google/gemini-2.5-flash` (pinned at run date; record provider-echoed model string) |
| Evaluator | deterministic code (Sections 6–9); no LLM judge |
| Temperature | optimizer 1.0; sampling runs 0 |
| LM call budget | ≤ 600 per run; ≤ 200 per candidate |
| Per-call timeout | 120 s |
| Retries | 2 per failed LM call, backoff 2 s then 8 s; abort after 3 consecutive failures |
| Concurrency | ≤ 4 in-flight LM calls |
| Artifacts | git-ignored paths only (`.tmp/`, `.local/`); nothing under `src/` |

Any change to this table is a contract version bump.

## 12. Splits (leakage-safe)

- Unit: **session**. All episodes of a session live in exactly one split.
- Order sessions by first-event `ts`; contiguous blocks: train 60% / development 20% / holdout 20% by session count (ties by `sessionId` lexical order; no randomness).
- Dedupe groups are atomic (Section 5): assigned to the split of earliest occurrence; later duplicates add weight only.
- **Holdout is sealed** until the final adoption report; intermediate artifacts label dev numbers `dev`.
- Split membership (session id list + counts) is recorded per run.

## 13. Deterministic review checklist (no doc-schema tooling in-repo)

1. Every Section 6 metric derivation references only fields named in Section 3 plus replay of shipped engines.
2. No holdout number appears outside the final adoption report.
3. Section 11 table has no TBD/placeholder values.
4. Baselines are exactly B0 and B1(Section 8); recovery and generic guidance appear only as fixtures/exclusions.
5. Section 7 lists content, path, and replacement fields by name; domain closure is mechanically checkable.
6. Version history below updated on any change.
7. `rg -in "let'?s[ ](try|fix|check|retry)|we[ ]apologize|sorry[ ]for" plans/contracts/` returns zero matches.

## 14. Version history

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-04 | Initial contract: FRV primary, hard invariants, session-time splits, fixed params, B0/B1, go/no-go, offline/runtime boundary. |
| 2 | 2026-09-04 | Review fixes: candidate space closed to repair transparency + factual result enrichment (repair-free events structurally out of domain); B1 corrected to shipped repair warnings + result enrichment (recovery is diagnostics-only post-0018); runtime promotion restricted to warnings/result-repair paths; metrics split into P1 (NRR) and P2 (FRV) populations because FRV is vacuous for already-repaired calls. |
