---
id: TASK-0040
title: Prevent Bash classification of valid source-tool calls
status: doing
depends_on: [TASK-0038]
priority: high
tags: [bash, routing, regression, schema, read]
---

# Prevent Bash classification of valid source-tool calls

## Problem
Valid canonical read calls such as `read({path})` are being intercepted by the non-exact Bash classifier and refused. Bash judgment must run only after the prepared arguments fail the attempted tool's real schema; valid read/write/edit calls must bypass Jev and execute normally.

## Acceptance criteria
- [ ] After the built-in `prepareArguments`, validate against the attempted tool's actual TypeBox schema before considering non-exact Bash judgment.
- [ ] Any source-schema-valid `read`, `write`, or `edit` call bypasses the Bash classifier, creates no sentinel/token, and executes the native tool unchanged.
- [ ] Cover canonical read path plus offset/limit, write path/content, and edit path/edits with a classifier injected; classifier call count remains zero.
- [ ] Preserve deterministic exact `{command, timeout?}` routing before source validation.
- [ ] Preserve Jev classification for source-schema-invalid calls with one bounded string candidate.
- [ ] Real AgentSession regression reproduces `read({path:"README.md"})` with classifier available and proves native content is returned.
- [ ] Missing-path read repair continues to see and repair native read calls.
- [ ] Keep command rerouting disabled locally until QA passes.
