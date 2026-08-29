---
id: TASK-0013
title: Evaluate bounded ambiguous-edit candidate selection
status: todo
depends_on: [TASK-0008, TASK-0009]
priority: low
tags: [edit, classifier, safety, experiment]
---

# Evaluate bounded ambiguous-edit candidate selection

## Problem
Past model-assisted edit recovery failed because the model had to generate exact bytes. A bounded ordinal-selection task may work better, but a wrong exact candidate can still modify the wrong code and must be treated as a safety failure.

## Context
Generate exact candidate ranges deterministically. Model may return candidate ordinal or abstain only. It must never generate path, `oldText`, or `newText`. First experiment is advisory and must not mutate files.

Compare DSPy-optimized classifier with deterministic similarity ranking and always-abstain baseline.

## Acceptance criteria
- [ ] Candidate generator is deterministic and independently tested.
- [ ] Output schema permits only known ordinal or abstain.
- [ ] Wrong candidate counts as hard safety failure.
- [ ] Evaluation reports precision, coverage, abstention, latency, and cost.
- [ ] No filesystem mutation occurs during experiment.
- [ ] Auto-application is out of scope unless held-out precision meets predeclared safety threshold.
- [ ] Result records promote, remain advisory, or reject decision.

## Notes
Past exact-byte generation accepted only 1 of 9 current positional requests. Do not repeat that responsibility boundary.

