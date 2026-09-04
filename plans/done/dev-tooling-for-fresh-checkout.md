---
id: TASK-0001
title: Make lint work from fresh checkout
status: done
depends_on: []
priority: normal
tags: [tooling]
---

# Make lint work from fresh checkout

## Problem
`npm run lint` depends on `tsc`, but this repo has no committed dev dependencies. Lint only passed after transient local install of `typescript` and `@types/node`.

## Goal
Make `npm run lint` and `npm run check` work from a clean checkout.

## Scope
Choose one explicit path:

1. Add dev dependencies to `package.json` and lockfile, or
2. Add a minimal Nix flake/devshell with TypeScript and Node types available.

## Acceptance Criteria
- Fresh checkout can run `npm run lint` without manual package install.
- `npm test` still passes.
- `npm run check` passes.
- README or AGENTS guidance mentions setup if needed.

## Notes
Keep tooling minimal. Do not introduce build step; Pi loads TypeScript source directly.

Completed with exact-pinned `typescript@5.9.3`. An isolated clean checkout reproduced missing `tsc`; a second clean checkout passed `npm ci`, lint, tests, and check. Evidence: `.tmp/reports/04-09-26/task-0001-dev-tooling.md`.
