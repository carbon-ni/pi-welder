---
id: TASK-0018
title: Remove generic automatic recovery messages
status: done
depends_on: []
priority: high
tags: [recovery, context, cleanup]
---

# Remove generic automatic recovery messages

## Problem
Pi-welder automatically injects generic failure advice that repeats known information without adding action-specific evidence or repairing the tool call.

## Context
Generic `failureHint` guidance repeats failure information during `context` handling. Action-specific evidence such as bounded missing-path trees and warnings tied to deterministic repairs remains useful.

## Acceptance criteria
- [ ] Automatic context handling no longer injects generic recovery messages after tool failures.
- [ ] Failure tracking and explicit diagnostic commands retain required behavior.
- [ ] Deterministic pre-execution repairs remain unchanged.
- [ ] Repair warnings remain tied to actual repairs.
- [ ] Result enrichment that adds factual action-specific context remains unchanged.
- [ ] Tests, lint, and package checks pass.

## Notes
Messages are acceptable only when they expose new context specific to the action or transparently describe a repair that occurred.

