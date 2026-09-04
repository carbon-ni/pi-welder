---
id: TASK-0017
title: Guide watcher socket configuration failures
status: todo
depends_on: []
priority: normal
tags: [watcher, recovery, tooling]
---

# Guide watcher socket configuration failures

## Problem
Watcher tools fail when their socket is not configured, but current recovery does not explain the safe direct-check fallback.

## Context
Latest Luna-session mining found four watcher failures stating that `on.socket` was not configured in `.watch.yaml`.

## Acceptance criteria
- [ ] Tests cover the exact socket-not-configured failure for watcher tools.
- [ ] Recovery recommends a direct, scoped check or explicit watcher configuration.
- [ ] Guidance never starts services or changes `.watch.yaml` automatically.
- [ ] Other watcher and generic tool failures retain existing guidance.
- [ ] Lint and package checks pass.

## Notes
Confirm whether this guidance belongs in pi-welder or the watcher tool before adding duplicated policy.

