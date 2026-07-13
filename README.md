# pi-welder

> The call goes in cracked. It comes out joined.

`pi-welder` is a [Pi](https://github.com/cristianoliveira/pi) extension that improves tool-call reliability. It sits between the model and the tools it calls, repairing common argument-shape mistakes *before* the tool runs, recording what it saw and did, and feeding the agent compact recovery guidance when a call still fails.

You can't retrain the model. But you can weld the seam.

## What it does

Every agent makes the same recurring mistakes — a path wrapped in a markdown link, `"true"` where a boolean belongs, a flat `oldText`/`newText` where `edits: [{...}]` is expected, a comma-separated string where an array is required. The tool throws, the turn burns tokens, the model apologizes.

`pi-welder` catches these and fixes them silently:

- 🔧 **Self-healing tool calls** — argument-shape repairs applied pre-execution: path cleaning, JSON unwrapping, array wrapping/splitting, boolean & number coercion, schema stripping, relational defaults, edit-field nesting.
- 🛡️ **Content-safe by contract** — `command`, `code`, `oldText`/`newText`, `text`, `content`, `prompt` and friends are never transformed. Only the *structure* is welded, never the workpiece.
- 📋 **Lean observability** — append-only JSONL logs of repairs and failures, grouped by `(tool, errorKind)` into ranked clusters. Records signals, not user content.
- 🩹 **Recovery guidance** — when a tool fails, welder injects a compact hint so the next turn fixes the cause instead of flailing.
- 📁 **Directory reads** — when `read` receives a directory, welder replaces the error with a sorted file/folder listing (folders end in `/`; output is capped at 200 entries).
- 🪶 **Zero footprint** — pure repair core, no Pi API leakage, never blocks tool execution. Side-effect failures are swallowed at the boundary.

## How it works

```
model ──tool call──▶ handlers ──repairArgs──▶ tool runs on the welded shape
                         │
                         ├── recorder (JSONL: repairs + failures)
                         └── recovery (failed-result tracking + guidance)
```

- On **`toolCall`**: `handlers.ts` runs the input through the pure `repairs/` engine, applies any fixes, and records what changed.
- On **`toolResult`**: failures are classified (`classifyErrorKind`), recorded, and added to the recovery window.
- On the **next turn**: pending failures surface as compact guidance to the model.

## Repairs

Repairs live in `src/repairs/` and are pure (no Pi APIs, no I/O, no clocks). The registry is intentionally ordered — earlier repairs shape later ones.

| Action | When it fires |
| --- | --- |
| `clean-path` | Path fields wrapped in markdown links / stray whitespace |
| `parse-json` | A string is actually JSON-encoded data |
| `array-shape` | An array field arrives as a bare value, a split-able string, or an object |
| `coerce-boolean` | `"yes"` / `"true"` / `"1"` on boolean fields |
| `coerce-number` | Numeric strings on number fields |
| `strip-extra-props` | Items duplicate parent-level props the schema doesn't allow |
| `relational-default` | `limit` without `offset` (or vice versa) |
| `nest-edit-fields` | Flat `oldText`/`newText` on the `edit` tool → `edits: [{...}]` |

Valid input passes through unchanged. Field classification is centralized in [`src/fields.ts`](src/fields.ts) — that's the only file that needs to change to grow coverage.

## Commands

| Command | Purpose |
| --- | --- |
| `/welder-stats` | Repair stats for this session |
| `/welder-status` | Runtime status |
| `/welder-on` · `/welder-off` · `/welder-toggle` | Enable / disable / toggle repairs (analytics still tracked) |
| `/welder-reset` | Reset session stats and pending recovery |
| `/welder-log` | Path to this session's JSONL log |
| `/welder-guidance` | Show current recovery guidance |
| `/welder-failures` | Show pending failures without hints |
| `/welder-guidance-limit <1-10>` | Cap failures included in guidance |
| `/welder-clear` | Clear pending recovery guidance |
| `/welder-mine [pi\|welder\|all]` | Aggregate failures across sessions and write a ranked report |

`/welder-mine` reads either welder's own logs, Pi's native session JSONL (`~/.pi/agent/sessions`), or both — so you can mine a week of real usage and let the data tell you the next rule to write.

Per-model repair ranking is opt-in because it can increase report cardinality. Configure it in `~/.pi/agent/welder.json`:

```json
{
  "modelRepairReportingEnabled": true
}
```

When disabled or absent (default), mining behavior and reports remain failure-only. Restart Pi after changing the file.

## Architecture

```
src/
├── index.ts         composition root — wires Pi events + commands
├── handlers.ts      orchestration: runtime ↔ repairs ↔ recorder ↔ recovery
├── commands.ts      /welder-* command specs + registration
├── runtime.ts       explicit per-session state (no hidden globals)
├── pi-context.ts    adapters: log dir, session id, model metadata
├── fields.ts        field classification (single source of truth for rules)
├── recovery.ts      failed-result tracking + guidance generation
├── repairs/         PURE input-repair core — engine, rules, helpers, types
├── result-repairs/  post-execution repair registry and result adapters
└── recorder/        observability — stats, events, JSONL I/O, aggregate, report
```

**Dependency direction**
- `index` wires `commands`, `handlers`, `runtime`.
- `handlers` orchestrates lower-level modules; lower-level modules never import `handlers`.
- `repairs/` stays pure — no Pi APIs, no I/O, no runtime state.
- `result-repairs/` owns post-execution repair rules; `handlers` only orchestrates and records their signals.
- Side-effect failures never block tool execution.

See [`AGENTS.md`](AGENTS.md), [`src/repairs/AGENTS.md`](src/repairs/AGENTS.md), and [`src/recorder/AGENTS.md`](src/recorder/AGENTS.md) for the module contracts.

## Develop

TypeScript ESM. No build step — Pi loads `src/index.ts` directly. Native Node test runner.

```bash
npm test          # run tests
npm run lint      # tsc --noEmit
npm run check     # lint + tests
```

When changing behavior, write or update tests first. Each module has a co-located `*.test.ts`; `repairs/` and `recorder/` keep characterization suites at `src/repairs.test.ts` and `src/recorder.test.ts`.

## Why "welder"?

A welder doesn't redesign the part. A welder sees a fracture and fuses it — quiet, structural, invisible once it's done. `pi-welder` does the same to tool calls: the model hands it a cracked argument shape, welder joins it into something the tool will accept before it ever sees the flaw. Content stays sacred; only the seam is closed.

## License

Private.
