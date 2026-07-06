---
name: pi-welder-mine
description: >
  Mine tool failures from welder + Pi session logs and write a ranked report.
  Use when user asks to mine, aggregate, or study recurring tool failures.
  Triggers: "mine welder failures", "what tools are failing", "show failure patterns",
  "aggregate failures", "what's failing most", "analyse tool failures".
  Do NOT use for editing code, live `/welder-*` commands in a running session,
  or per-session stats (use `/welder-stats`).
---

# pi-welder-mine

Mine welder and Pi session logs for recurring tool-failure patterns, aggregate by `(toolName, errorKind)`, and write a ranked markdown report so the user can decide which patterns deserve new repair rules.

## Workflow

1. Run the mine script from the **pi-welder project root**:
   ```bash
   node --experimental-strip-types .pi/skills/pi-welder-mine/scripts/run-mine.ts [pi|welder|all]
   ```
   - `all` (default): both sources. 30–60s, use a timeout.
   - `pi`: Pi native sessions only (`~/.pi/agent/sessions/*/*.jsonl`).
   - `welder`: welder's own logs only (`.pi/welder-log/*.jsonl`).

2. Read the report it writes: `.pi/welder-log/failures-report.md`.

3. Present the top 3–5 clusters to the user. For each, show `toolName / errorKind (×count)` and one sample. Do not auto-write repairs — let the user decide.

## Triage guide

- **Structural clusters** (repair candidates): `ENOENT`, `EDIT_MISMATCH`, `SCHEMA`. Check whether a `repairArgs` rule could fix the shape.
- **Execution clusters** (not repairable): `bash / TOOL_ERROR` dominates because non-zero exits get flagged. Tell the user these are noise, not actionable.

## Guardrails

- Must run from pi-welder project root — the script imports `src/`.
- Do not run if `src/` imports are broken (mid-refactor): run `npm run lint` first.
- The report overwrites the previous one (point-in-time snapshot).
- Never run this inside a live pi session to call `/welder-mine`; use the script or `bash` here.

## Validation

- Script exits 0 and prints `mineSummary` lines (`source`, `report`, `clusters`, `failures`, `top`).
- Report file exists and contains `# pi-welder failure report`.
