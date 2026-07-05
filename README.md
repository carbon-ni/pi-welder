# pi-welder

A pi extension that registers harness-level tool failures (schema/syntax errors,
unknown tools, harness-side read/edit/write failures, bash spawn failures) and
collects data for each one. CLI bash failures (non-zero exit codes) are
intentionally excluded.

## Layout

```
src/
  failure-log.ts      pure logic (classifyFailure, recordFailure, summarize)
  failure-log.test.ts node:test suite (12 tests)
  index.ts            pi wiring: tool_result hook + /failures command
.pi/extensions/welder.ts  thin re-export so `pi` auto-loads it in this project
```

## Develop

```bash
npm test                              # run unit tests (node:test, no install)
pi -e ./.pi/extensions/welder.ts      # load explicitly
pi -p "..."                           # auto-loads via .pi/extensions/
```

## What gets recorded

Per failure: `{ id, timestamp, kind: "syntax"|"harness", toolName, toolCallId, cwd, input, errorContent }`

- `kind: "syntax"` — validation / JSON parse / schema errors
- `kind: "harness"` — other tool execution errors (ENOENT, unknown tool, spawn failure, ...)
- Excluded — bash results with a defined `exitCode` (those are CLI failures)

Storage: `pi.appendEntry("welder-failures", log)` — in-session, survives reload,
branches correctly. Reconstructed on `session_start` / `session_tree`.

## View

`/failures` — prints the current registry.
