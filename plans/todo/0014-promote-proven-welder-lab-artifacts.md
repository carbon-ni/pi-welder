---
id: TASK-0014
title: Promote proven Welder Lab artifacts
status: todo
depends_on: [TASK-0010, TASK-0011, TASK-0012]
priority: normal
tags: [adoption, runtime, rollback]
---

# Promote proven Welder Lab artifacts

## Problem
Optimization experiments create no user value until proven winners become simple, reviewable pi-welder behavior. Adoption must preserve deterministic runtime boundaries, support rollback, and explicitly reject candidates that do not beat baseline.

## Context
Review experiment evidence and promote only candidates that pass safety and holdout gates. Prefer exporting static hints/examples into existing pure modules. Keep DSPy and AgentDB offline unless evidence proves dynamic runtime behavior is necessary.

## Acceptance criteria
- [ ] Each candidate has accept/reject decision linked to held-out evidence.
- [ ] Accepted artifact is static, versioned, reviewable, and has rollback path.
- [ ] Runtime adds no model call or database by default.
- [ ] Existing error text remains unchanged and visible.
- [ ] Tests cover repaired, unchanged, disabled, and error paths.
- [ ] Documentation states optimization source, supported scope, and expiry/re-evaluation trigger.
- [ ] Localized checks and regression-risk review pass.
- [ ] Final report records rejected ideas so they are not repeated without new evidence.

## Notes
If no candidate beats baseline, successful outcome is keeping current behavior and preserving benchmark for future models.

