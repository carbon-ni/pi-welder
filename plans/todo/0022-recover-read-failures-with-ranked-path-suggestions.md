---
id: TASK-0022
title: Auto-restore missing read paths with bounded Jev ranking
status: doing
depends_on: []
priority: high
tags: [read, recovery, typesafe, auto-repair, safety]
---

# Auto-restore missing read paths with bounded Jev ranking

## Problem
`read / ENOENT` is the fastest-growing structural failure: 1,498 cases and +89 between the last two mining snapshots. The requested path is often a typo, rename, or moved file. Welder currently lets the read fail even when nearby existing files provide a bounded repair set.

## Desired outcome
When a requested read path does not exist, generate existing candidate paths deterministically, let Jev select one ordinal or abstain, validate the selection, and transparently replace only `read.path`. Any uncertainty or failure preserves the original call unchanged.

## Safety contract

```text
missing read path
  → deterministic existing candidates (max 5)
  → Jev ordinal or abstain
  → confidence >= 0.9
  → realpath containment + readable regular-file postcheck
  → mutate read.path transparently
```

Jev never generates paths. This is a side-effect-free read repair, but a wrong file can still mislead later reasoning: reviewed precision and zero wrong-target violations remain mandatory.

## Acceptance criteria

### Evidence
- [ ] Mine missing-read failures paired with the next successful read in the same session; report pair count and deterministic top-1/top-5 hit rates.
- [ ] Evaluate Jev offline on the paired set before enabling runtime mutation: known ordinals only, fixed confidence threshold 0.9, at least 30 reviewed labels, precision >=0.99, zero wrong-targets.
- [ ] If the gate is not met, ship shadow-only evidence and an explicit insufficient-data verdict; do not auto-repair.

### Deterministic candidates
- [ ] Missing-path detection and candidate generation are bounded under the real session cwd; symlink/path escape, unreadable roots, directories, and files outside cwd fail closed.
- [ ] At most 5 readable regular files, ranked deterministically by basename/path similarity with stable tie-breaking.
- [ ] Clean existing paths, directory reads, non-read tools, and malformed inputs make no Jev request.

### Jev selection and repair
- [ ] Jev receives only the requested relative path plus bounded candidate relative paths; no file contents, source windows, credentials, absolute paths, or conversation payload.
- [ ] Output is one known ordinal or abstain. Unknown, malformed, low-confidence, timeout, transport, cancellation, or rate-limit leaves the call unchanged.
- [ ] Selected path is revalidated for containment/readability immediately before mutating `event.input.path`.
- [ ] Successful repair records a distinct `restore-read-path` action and transparently reports requested→selected metadata without persisting either path.
- [ ] One bounded request, 2-second timeout, zero retries; no filesystem mutation.

### Configuration and observability
- [ ] Disabled by default behind a separate persisted `readPathRepairEnabled` opt-in plus nonblank `TYPESAFE_API_KEY`; source-shadow consent does not implicitly enable path repair.
- [ ] Settings/README disclose that repository paths leave the machine and that a wrong read can influence later reasoning.
- [ ] Metadata-only counters distinguish eligible, selected, abstained, low-confidence, failed, repaired, and provisional/correct/incorrect labels.
- [ ] Tests cover opt-in/off, candidate ranking, containment, symlinks, every failure class, low confidence, exact input mutation, transparency, no path logging, and unchanged-call fallback.

## Non-goals
- Jev generating paths or reading file contents.
- Repairing directory reads in this task.
- Applying a candidate without meeting the evidence gate.
- Mutating any tool other than `read.path`.
