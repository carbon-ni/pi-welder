# pi-welder

> The call goes in cracked. It comes out joined.

`pi-welder` is a [Pi](https://github.com/cristianoliveira/pi) extension that improves tool-call reliability. It sits between the model and the tools it calls, repairing common argument-shape mistakes *before* the tool runs, recording what it saw and did, and feeding the agent compact recovery guidance when a call still fails.

You can't retrain the model. But you can weld the seam.

## Install

```bash
pi install npm:@carbon-ni/pi-welder      # latest
pi install npm:@carbon-ni/pi-welder@0.0.1 # pinned
pi -e npm:@carbon-ni/pi-welder           # try it for one run only
```

Pi provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
`typebox` itself, so they are declared as `peerDependencies` with a `"*"` range
and are never bundled. The package ships only runtime source plus
`README.md` and `LICENSE`; tests, plans, scripts, and local state are excluded.

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
| `resolve-ambiguous-edit` | Preflight makes a locator unique, normalizes whitespace, or narrows stale outer context to an exact change hunk |
| `edit-noop` | A failed single no-op edit is verified against current file and returned as successful desired state |

Valid input passes through unchanged. Input field classification is centralized in [`src/fields.ts`](src/fields.ts). Filesystem-backed preflight and result repairs live outside the pure input engine and abstain when current state cannot prove a safe repair.

## Commands

| Command | Purpose |
| --- | --- |
| `/welder-stats` | Repair stats for this session |
| `/welder-reset` | Reset session stats and pending recovery |
| `/welder-log` | Path to this session's JSONL log |
| `/welder-guidance` | Show current recovery guidance |
| `/welder-failures` | Show pending failures without hints |
| `/welder-clear` | Clear pending recovery guidance |
| `/welder-settings` | Toggle config options (TUI only; persists to `~/.pi/agent/welder.json`) |

Per-model repair ranking is opt-in because it can increase report cardinality. Configure it in `~/.pi/agent/welder.json`:

```json
{
  "modelRepairReportingEnabled": true
}
```

When disabled or absent (default), mining behavior and reports remain failure-only. Restart Pi after changing the file.

### Jev source shadowing (opt-in, sends source off-machine)

When an exact edit target is ambiguous (2–5 exact occurrences of `oldText`) and deterministic repair cannot resolve it, welder can ask TypeSafe's Jev which candidate was intended — purely as shadow evidence. The original edit proceeds unchanged; Jev can never mutate calls, files, or results.

This is **off by default** and requires two things: the persisted setting below **and** a `TYPESAFE_API_KEY` environment variable. When enabled, **bounded, credential-redacted repository source leaves this machine**: at most 5 candidate windows of 20 lines / 2 KiB each (12 KiB total) plus the sanitized requested edit text, capped at 10 requests per session, one at a time, 2-second timeout, zero retries. Logs persist only candidate counts, chosen ordinal/abstention, confidence, latency, and status — never paths, source, edit text, or payloads.

```json
{
  "sourceShadowingEnabled": true
}
```

### Jev read-path repair (opt-in, sends relative paths off-machine)

When a `read` targets a path that does not exist, welder generates up to 5
nearby existing files, asks TypeSafe's Jev to rank one, and — after a
post-validation of the selected candidate — transparently replaces `read.path`.
It is **off by default** and needs both the persisted setting below **and** a
`TYPESAFE_API_KEY`; those two are what enable it. There is no hidden runtime
gate: a plan exists only when the setting is on and a client exists.

Bounded by construction: candidates are capped at 5, selection must reach
confidence **≥ 0.9**, the Jev call has a **2 s** deadline with **zero retries**,
and the chosen path is re-validated immediately before mutation (containment,
regular file). A candidate whose size is known to exceed **1 MiB** fails closed
without being read, so the post-check never pulls a huge file into memory.

When enabled, **relative repository paths leave this machine**: the requested
relative path plus up to 5 candidate relative paths. No file contents, source
windows, credentials, absolute paths, or conversation payloads are sent, and the
JSONL log keeps only counts, statuses, and field names — never paths.

The predeclared offline evaluation from TASK-0022 (30 human-reviewed labels,
precision ≥ 0.99, zero wrong targets) **failed** and is kept as
[historical evidence](src/read-recovery/evidence-gate.ts). It is documentation,
not a switch: it no longer gates runtime behavior.

```json
{
  "readPathRepairEnabled": true
}
```

### Stats categories

`/welder-stats` separates what the extension actually did:

- **repairs (input transformed or routed)** — argument repairs, `route-to-bash`,
  `restore-read-path`; these count in `calls repaired`.
- **result recoveries (verified patch, input unchanged)** — `edit-noop`,
  `directory-read`, `read-offset-context`.
- **diagnostic enrichments (context only, never a repair)** —
  `missing-read-context`.

Only the first category is a repair; the other two are reported separately and
never inflate the repaired-call count.

## Architecture

```
src/
├── index.ts         composition root — wires Pi events + commands
├── handlers.ts      orchestration: runtime ↔ repairs ↔ recorder ↔ recovery
├── commands.ts      /welder-* command specs + registration
├── runtime.ts       explicit per-session state (no hidden globals)
├── infra/pi/        local Pi host contracts + context adapters
├── fields.ts        field classification (single source of truth for rules)
├── infra/           injectable filesystem adapter + local Pi host contracts
├── recovery.ts      failed-result tracking + guidance generation
├── repairs/         PURE input-repair core — engine, rules, helpers, types
├── result-repairs/  post-execution repair registry and result adapters
└── recorder/        observability — stats, events, JSONL I/O, aggregate, report
```

**Dependency direction**
- `index` wires `commands`, `handlers`, `runtime`.
- `handlers` orchestrates lower-level modules; lower-level modules never import `handlers`.
- `repairs/` stays pure — no Pi APIs, no I/O, no runtime state.
- `infra/` owns external clients and local Pi host contracts; recovery and result-repair modules accept narrow injected capabilities for deterministic tests.
- Pi host types do not leak into handlers or commands; `index.ts` wires the host through consumer-owned structural contracts.
- `result-repairs/` owns post-execution repair rules; `handlers` only orchestrates and records their signals.
- Side-effect failures never block tool execution.

See [`AGENTS.md`](AGENTS.md), [`src/repairs/AGENTS.md`](src/repairs/AGENTS.md), and [`src/recorder/AGENTS.md`](src/recorder/AGENTS.md) for the module contracts.

## Develop

TypeScript ESM. No build step — Pi loads `src/index.ts` directly. Native Node test runner.

```bash
npm test               # extension tests
npm run test:scripts   # release/package script tests
npm run lint           # tsc --noEmit
npm run check          # lint + both test suites
npm run verify:package # pack once, isolated consumer, real Pi host load
make verify            # everything above
```

When changing behavior, write or update tests first. Each module has a co-located `*.test.ts`; `repairs/` and `recorder/` keep characterization suites at `src/repairs.test.ts` and `src/recorder.test.ts`.

## Why "welder"?

A welder doesn't redesign the part. A welder sees a fracture and fuses it — quiet, structural, invisible once it's done. `pi-welder` does the same to tool calls: the model hands it a cracked argument shape, welder joins it into something the tool will accept before it ever sees the flaw. Content stays sacred; only the seam is closed.

## License

MIT. See [LICENSE](LICENSE). Operators should read [RELEASING.md](RELEASING.md)
before creating a release.
