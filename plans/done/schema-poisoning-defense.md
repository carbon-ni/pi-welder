---
id: TASK-0005
title: Add schema poisoning defense for provider requests
status: done
depends_on: []
priority: normal
tags: [schema, providers]
---

# Add schema poisoning defense for provider requests

## Problem
Some models copy JSON Schema regex anchors (`^`, `$`) from tool schemas into generated argument values. This causes avoidable bad tool calls.

## Goal
Sanitize outgoing provider request schemas for affected models before the model sees them.

## Scope
- Investigate whether Pi extension API exposes `before_provider_request` in this project/version.
- Add a small pure sanitizer for schema `pattern` fields.
- Strip simple anchors (`^foo$` -> `foo`).
- Drop risky anchored alternation patterns when stripping would change semantics too much.
- Gate by model id/provider only if signal exists.

## Acceptance Criteria
- Unit tests cover simple anchor stripping, risky pattern dropping, nested schema traversal, and passthrough for unaffected schemas.
- Handler is no-op when event/model context is unavailable.
- Logging/handler failures never block provider request.
- `npm test` and `npm run lint` pass.

## Out of Scope
- Repairing generated values post-hoc unless mined failures prove need.
- Full schema rewriting beyond `pattern` anchors.

## Decision
Rejected from current evidence. Full-session and Welder scans found zero contaminated generated values or paired canonical retries; built-in Pi tools expose no schema `pattern` constraints. Although Pi 0.83.0 provides `before_provider_request`, rewriting provider schemas without a model-specific signal would be speculative and could change validation semantics. Revisit only with a mined contaminated-call and canonical-retry pair. Evidence: `.tmp/reports/04-09-26/task-0005-schema-poisoning-evidence.md`.
