# Repairs Module Guide

## Purpose

`src/repairs/` is the pure repair core. It transforms malformed tool-call argument objects into safer structural shapes before tools run.

No filesystem, Pi APIs, UI, clocks, logging, or runtime state belong here.

## File Map

- `index.ts`: public facade. Re-export stable repair API from here.
- `types.ts`: repair contracts, rule interfaces, and result shapes.
- `helpers.ts`: scalar pure helpers such as JSON parsing, boolean/number coercion, null-like detection, markdown-link unwrapping, and string splitting.
- `rules.ts`: ordered per-value repair rule registry.
- `object-rules.ts`: top-level object repair rules, such as relational defaults.
- `engine.ts`: recursive traversal and `repairArgs` orchestration.

## Change Placement

- Add new structural input fixes as rules in `rules.ts` when they operate on one value.
- Add top-level cross-field behavior in `object-rules.ts`.
- Add reusable pure scalar logic in `helpers.ts`.
- Add/adjust field classification in `../fields.ts`, not inside rule logic.
- Add new shared contracts in `types.ts` and re-export them through `index.ts` only when external modules need them.

## Rules

- Preserve rule ordering intentionally; earlier repairs shape later repairs.
- Valid input should pass through unchanged.
- Content fields must stay content-safe. Do not rewrite command/code/exact text fields unless tests define that behavior.
- Repair argument structure and types only; do not infer user intent.
- Keep `engine.ts` orchestration-focused. Avoid embedding specific repair policy there.

## Tests

Use `src/repairs.test.ts` as the characterization suite for public repair behavior and registry contracts. Cover repaired and unchanged cases for every new rule.
