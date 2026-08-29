---
id: TASK-0011
title: Optimize redacted structural few-shot examples
status: todo
depends_on: [TASK-0008, TASK-0009]
priority: normal
tags: [dspy, few-shot, privacy]
---

# Optimize redacted structural few-shot examples

## Problem
Models may learn correct tool-call shapes better from examples than prose, but examples can leak content and consume context. We need evidence for whether a small, structurally redacted demonstration set improves unrepaired tool-call success.

## Context
Transform successful repairs into structural demonstrations containing field names, types, nesting, and placeholders only. Optimize example selection and count under strict context budget.

Compare examples against prose-only guidance and no guidance. Avoid retrieval unless static per-action examples prove value first.

## Acceptance criteria
- [ ] Redactor removes argument values and content fields deterministically.
- [ ] Leakage tests cover paths, commands, prompts, code, text, and edit content.
- [ ] Examples preserve schema-relevant structure and repair action.
- [ ] Candidate sets include zero, one, and bounded multiple examples.
- [ ] Evaluation reports validity gain and added tokens.
- [ ] Holdout result follows TASK-0006 thresholds.
- [ ] Winner or explicit rejection is documented.

## Notes
Prefer one canonical static example over AgentDB retrieval unless evidence shows retrieval wins.

