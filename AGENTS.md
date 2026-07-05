# pi-welder Agent Guide

## Purpose

`pi-welder` is a Pi extension that improves tool-call reliability. It observes Pi tool calls/results, repairs common malformed argument shapes before tools run, records repair/failure signals, and injects compact recovery guidance after tool failures.

## Architecture

Keep the project split between a pure repair core and Pi side-effect boundaries.

- `src/index.ts` is the composition root. Wire Pi events and commands here only.
- `src/repairs.ts` is the pure repair engine. Keep it deterministic: no filesystem, no Pi APIs, no UI, no time-dependent behavior.
- `src/fields.ts` owns field classification constants and predicates used by repair rules.
- `src/handlers.ts` coordinates Pi event handling. It may call repair, recorder, recovery, context helpers, and runtime helpers.
- `src/recorder.ts` owns in-memory stats and JSONL log I/O.
- `src/recovery.ts` owns failed-tool-result tracking and recovery message generation.
- `src/commands.ts` owns `/welder-*` command specs and command registration.
- `src/runtime.ts` owns explicit session runtime state.
- `src/pi-context.ts` adapts Pi context into local values such as log directory, session id, and model metadata.

Dependency direction should stay simple:

- `index` wires `commands`, `handlers`, and `runtime`.
- `handlers` orchestrates lower-level modules; lower-level modules must not import `handlers`.
- `repairs` may depend on `fields`; `fields` should not depend on repair/runtime/Pi modules.
- `runtime` may compose stats and recovery state; avoid hiding runtime state in globals.

## Design Rules

- Prefer explicit runtime injection over module-level mutable state.
- Keep repair behavior content-safe. Do not transform content fields such as commands, code, or exact text replacements unless tests define that contract.
- Repairs should fix argument structure/types, not reinterpret user intent.
- Logging and recovery must never block or break tool execution; side-effect failures should be swallowed at the handler boundary.
- Add new repair behavior as a rule in the repair registry when possible. Preserve rule ordering intentionally because earlier repairs can shape later ones.
- Keep event log schema lean. Log signals useful for debugging model/tool behavior, not full user content.

## Testing

Use Node's built-in test runner through package scripts:

- `npm test` runs tests.
- `npm run lint` type-checks.
- `npm run check` runs lint and tests.

When changing behavior, write or update tests first. Prefer module-local tests next to the file under change (`src/<module>.test.ts`). Cover both repaired and unchanged inputs, plus disabled/error paths when touching handlers or runtime behavior.

## Where to Put Changes

- New structural input fixes: `src/repairs.ts`, with field classification in `src/fields.ts` if needed.
- New command behavior: `src/commands.ts`.
- New Pi event orchestration: `src/handlers.ts`, wired from `src/index.ts` if it needs a new event.
- New persistent/logged signal: `src/recorder.ts` plus handler integration.
- New recovery hint behavior: `src/recovery.ts`.
- Runtime state shape changes: `src/runtime.ts`, then adapt handlers/commands explicitly.
