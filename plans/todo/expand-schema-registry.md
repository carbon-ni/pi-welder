# Expand schema registry and aliases from evidence

## Problem
`src/schemas.ts` currently covers a small set of known tools and aliases. More tools/aliases may benefit from validate-then-repair, but speculative schema growth can create false confidence.

## Goal
Expand schema-aware validation only where real failures show repeated malformed inputs.

## Scope
- Use mined failure reports to identify recurring aliases or type mismatches.
- Add schemas for additional tools only when field expectations are stable.
- Add aliases with tests for canonical rename and no-op when canonical field already exists.
- Keep schema validation lightweight and optional.

## Acceptance Criteria
- Every new alias/schema has a failing test first.
- Valid known-tool inputs pass through unchanged.
- Partial repair rollback remains covered.
- Unknown tools keep current field-taxonomy repair behavior.
- `npm test` and `npm run lint` pass.

## Notes
Prefer one source of truth in `src/schemas.ts`. Do not duplicate aliases in repair rules.
