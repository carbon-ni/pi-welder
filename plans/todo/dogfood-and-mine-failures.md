# Dogfood and mine remaining tool failures

## Problem
We added schema-aware repair validation, but we need real-session evidence before adding more repair rules.

## Goal
Use pi-welder in normal Pi sessions, then mine logs to rank the next repair opportunities by frequency and impact.

## Scope
- Run pi-welder for real work sessions.
- Use `/welder-mine all` to aggregate welder + Pi session failures.
- Review top clusters by `(tool, errorKind)`.
- Convert only high-signal recurring failures into new tests/rules.

## Acceptance Criteria
- A fresh failure report exists under welder log/report output.
- Top 3 recurring failures are summarized with sample input keys and error kinds.
- At least one next repair candidate is selected or explicitly rejected with reason.

## Notes
Prefer data-driven rules. Do not add speculative model-specific fixes without mined evidence.
