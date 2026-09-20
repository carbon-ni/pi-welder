---
id: TASK-0034
title: Execute exact bash-shaped wrong-tool calls
status: doing
depends_on: [TASK-0033]
priority: high
tags: [bash, routing, execution, opt-in, security]
---

# Execute exact bash-shaped wrong-tool calls

## Problem
When an agent sends exact bash arguments to a non-bash core tool, the intent evidence is strong enough to execute the unchanged command. Pi cannot replace tool identity in `tool_call`, so Welder must execute through an injected built-in bash capability, block the invalid original call, and correlate its real result.

## Desired outcome
With explicit opt-in, an exact bash-shaped call mistakenly addressed to `read`, `write`, or `edit` executes once through Pi's built-in bash tool and returns the real command result. Other shapes and untrusted projects fail closed.

## Acceptance criteria
- [ ] Add an explicit `commandReroutingEnabled` config setting; default false.
- [ ] Recognize only `read`/`write`/`edit` calls whose original input has exactly `command` plus optional `timeout`, with a non-empty string command and finite timeout in the accepted range.
- [ ] Do not call Jev at runtime: the gate is the frozen 195/195 unique-schema evidence and exact deterministic validation.
- [ ] Require `ctx.isProjectTrusted() === true`; missing/false trust abstains.
- [ ] Execute the original command and timeout unchanged through an injected adapter around Pi's built-in `createBashTool`; preserve cwd and cancellation signal.
- [ ] Execute at most once, block the invalid original call, and correlate the pending bash result by tool-call ID.
- [ ] Replace the blocked tool result with the real bash content/details/error outcome; never include the command in logs or recovery messages.
- [ ] Emit a transparent `route-to-bash` repair/audit signal containing source and target tool names only.
- [ ] Clear pending state on result consumption and session shutdown; parallel call IDs remain isolated.
- [ ] Fail closed on executor errors, duplicate IDs, disabled setting, disabled repair, unknown/extra fields, invalid types/ranges, attempted bash, or untrusted project.
- [ ] Cover success, command failure, abort/error, parallel calls, no duplicate execution, and all abstention paths with deterministic tests.
- [ ] Run localized security review and package checks before enabling the user's local config.

## Non-goals
- Rerouting arbitrary custom tools.
- Generating or rewriting commands.
- Treating Jev confidence as execution authorization.
- Executing a command when exact schema validation or project trust is unavailable.
