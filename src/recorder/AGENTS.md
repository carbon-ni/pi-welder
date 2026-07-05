# Recorder Module Guide

## Purpose

`src/recorder/` owns observability for pi-welder: in-memory stats, lean event records, and append-only JSONL session logs.

Recorder code should record signals, not full tool content.

## File Map

- `index.ts`: public facade. Re-export recorder API from here.
- `stats.ts`: `Stats`, counters, failure counts, and human-readable stats summary.
- `events.ts`: `WelderEvent` schema and event builders for tool-call/tool-result observations.
- `log.ts`: JSONL log path, append, read, list, load-all, write-failure-report, and session log pruning.
- `aggregate.ts`: pure `aggregateFailures(events)` — groups failures by `(toolName, errorKind)` into ranked clusters.
- `report.ts`: pure `formatFailureReport(clusters)` — markdown rendering of clusters.

## Change Placement

- Add new counters or summaries in `stats.ts`.
- Add new logged fields or event-building behavior in `events.ts`.
- Add file/log persistence behavior in `log.ts`.
- Add failure-grouping or reduction logic in `aggregate.ts`.
- Add report formatting (markdown/plain) in `report.ts`.
- Export new public recorder API through `index.ts`.
- Handler-level decisions about when to record belong in `../handlers.ts`, not here.
- Command-level orchestration (load → aggregate → write) belongs in `../commands.ts`.

## Rules

- Keep log schema lean and stable.
- Do not log full commands, code, replacement text, or bulky tool content.
- Log useful debugging signals: tool name, model metadata, repair actions, input keys, bounded failure text.
- File I/O failures should be handled by callers at the side-effect boundary; recorder functions should remain straightforward.
- Stats are per-session runtime state and should be created/reset through `../runtime.ts`.

## Tests

Use `src/recorder.test.ts` for stats, event schema, JSONL read/write, malformed-line tolerance, and pruning behavior.
