# pi-welder

A pi extension for **model tool-call mistake telemetry**.

The goal is to understand where models make tool-call mistakes most often, then
repair the most common safe patterns. Logging/persistence is only the collection
mechanism, not the product goal.

Inspired by [`pi-tool-repair`](https://github.com/monotykamary/pi-tool-repair):
observe finite recurring mistake patterns, rank hotspots, then repair them in a
small ordered pipeline.

## Current signals

- `tool_call` phase: pre-execution schema/syntax mistake patterns
  - `aliased_field`
  - `null_optional`
  - `empty_object_placeholder`
  - `stringified_array`
  - `bare_string_array`
  - `bare_string_root`
- `tool_result` phase: harness-side errors after execution
  - `tool_result_error`
  - excludes bash CLI results with a defined `exitCode`

## Layout

```
src/
  tool-mistakes.ts        pure telemetry logic (mistake collection + hotspot summary)
  tool-mistakes.test.ts   node:test suite for model mistake patterns
  failure-log.ts          legacy harness failure view (kept for compatibility)
  failure-log.test.ts     legacy tests
  tool-repair.ts          pure conservative repair rules
  tool-repair.test.ts     repair-rule tests
  index.ts                pi wiring: tool_call + tool_result hooks, /mistakes + /failures
.pi/extensions/welder.ts  thin re-export so `pi` auto-loads it in this project
```

## Develop

```bash
npm test                              # run unit tests (node:test, no install)
pi -e ./.pi/extensions/welder.ts      # load explicitly
pi -p "..."                           # auto-loads via .pi/extensions/
```

## What gets recorded

Per mistake:

```ts
{
  id,
  timestamp,
  kind: "syntax" | "schema" | "harness",
  phase: "tool_call" | "tool_result",
  pattern,
  toolName,
  toolCallId,
  cwd,
  modelId?,
  input?,
  field?,
  receivedField?,
  errorContent?,
  repaired?,
  repairRules?,
}
```

Storage: `pi.appendEntry("welder-tool-mistakes", telemetry)` — in-session,
survives reload, branches correctly. Reconstructed on `session_start` /
`session_tree`.

Legacy harness failure storage remains as `welder-failures` until the telemetry
view fully replaces it.

## View

- `/mistakes` — hotspot summary grouped by `model tool pattern`, including repaired counts
- `/failures` — legacy harness-failure summary

## Repair mode

Default mode is observe-only. To enable conservative repairs:

```bash
WELDER_REPAIR_MODE=repair pi -e ./.pi/extensions/welder.ts
```

Current repairs are schema-scoped and deterministic:

1. `wrapRootStringAsObject`
2. `renameAliasedField`
3. `dropNullOptional`
4. `dropEmptyObjectPlaceholder`
5. `parseJsonStringifiedArray`
6. `wrapBareStringAsArray`

Repairs only run for known built-in tool schemas, do not mutate original input
inside the pure repair function, and are applied only when the repaired input
validates against the known schema.
