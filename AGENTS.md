# pi-welder Agent Guide

## Purpose

`pi-welder` is a Pi extension that improves tool-call reliability. It observes Pi tool calls/results, repairs common malformed argument shapes before tools run, records repair/failure signals, and injects compact recovery guidance after tool failures.

## Code Map

Use this file as the index. Read nested module guides before changing folder modules.

- `src/index.ts`: composition root. Wire Pi events and commands here only.
- `src/handlers.ts`: Pi event orchestration. Coordinates runtime, repairs, recorder, recovery, and UI status.
- `src/commands.ts`: `/welder-*` command specs and command registration.
- `src/runtime.ts`: explicit session runtime state. Avoid hidden globals.
- `src/pi-context.ts`: adapters from Pi context to local values: log dir, session id, model metadata.
- `src/fields.ts`: field classification constants/predicates used by repair rules.
- `src/recovery.ts`: failed-tool-result tracking and recovery guidance generation.
- `src/repairs/`: pure repair core. See `src/repairs/AGENTS.md`.
- `src/recorder/`: observability: stats, event schema, JSONL log I/O. See `src/recorder/AGENTS.md`.

## Dependency Direction

- `index` wires `commands`, `handlers`, and `runtime`.
- `handlers` orchestrates lower-level modules; lower-level modules must not import `handlers`.
- `commands` may inspect/mutate runtime through public module APIs; keep command behavior out of `index`.
- `repairs` may depend on `fields`; `fields` must not depend on repair/runtime/Pi modules.
- `runtime` may compose stats and recovery state; do not hide runtime state in module globals.
- Side-effect modules should not leak Pi APIs into pure modules.

## Design Rules

- Prefer explicit runtime injection over module-level mutable state.
- Keep repair behavior content-safe. Do not transform content fields such as command, code, or exact text replacements unless tests define that contract.
- Repairs should fix argument structure/types, not reinterpret user intent.
- Logging and recovery must never block or break tool execution; swallow side-effect failures at the handler boundary.
- When edit recovery cannot safely apply a change, return bounded fresh target-file context in the error so the agent does not need a separate read round.
- Keep event log schema lean. Log signals useful for debugging model/tool behavior, not full user content.

## Testing

Use package scripts:

- `npm test` runs tests.
- `npm run lint` type-checks.
- `npm run check` runs lint and tests.

When changing behavior, write or update tests first. Prefer module-local tests next to the public module under change. Cover repaired and unchanged paths, plus disabled/error paths when touching handlers or runtime behavior.
