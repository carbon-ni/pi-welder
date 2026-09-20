---
id: TASK-0033
title: Mine and evaluate wrong-tool routing by argument schema
status: doing
depends_on: [TASK-0030]
priority: high
tags: [routing, schema, wrong-tool, jeq, safety, mining]
---

# Mine and evaluate wrong-tool routing by argument schema

## Problem
Agents sometimes send arguments for one tool to another, such as invoking `write` with `bash`'s `command`/`timeout` shape. These failures may be recoverable by matching argument keys/types against known tool schemas, with Jev reserved for genuinely ambiguous candidate tools.

## Desired outcome
Measure how often wrong-tool calls can be identified deterministically, when probabilistic intent selection adds value, and which reroutes must remain blocked because they increase capability.

## Method

1. Mine validation/schema failures and inspect up to three following calls for a successful corrected call with structurally equivalent arguments.
2. Build a closed schema-signature registry for observed core tools from their required/optional keys and value types.
3. Generate candidate target tools whose schema accepts the original argument shape.
4. One exact candidate is a deterministic routing result; multiple candidates become explicit intent hypotheses for Jev; no candidate abstains.
5. Hidden label is the bounded later successful tool with equivalent arguments. Future behavior never enters requests.
6. Classify source and target capabilities: read-only, filesystem mutation, process execution, communication/external side effect.

## Acceptance criteria
- [ ] Report total wrong-tool episodes, tools involved, candidate-set coverage, unique versus ambiguous schema matches, and attrition to hidden labels.
- [ ] Include core `read`, `write`, `edit`, and `bash` schemas and expand only from verified local tool contracts.
- [ ] Schema matching validates required keys, optional keys, unknown keys, and value types; matching is deterministic and tested.
- [ ] Requests contain only attempted tool, argument keys/types, candidate tool IDs, failure class, and bounded closed pre-failure signals; no values, paths, commands, source, credentials, conversation, or future behavior.
- [ ] Use installed `jeq`, zero retries, hardened Choice parsing, and compare against deterministic candidate ranking.
- [ ] Report accuracy, calibration, abstention, and precision/coverage at confidence >=0.90 and >=0.99, split by unique/ambiguous cases.
- [ ] A unique schema match may be considered for future deterministic repair only when the target capability is equal or lower. Capability escalation remains blocked regardless of Jev confidence.
- [ ] Any probabilistic promotion requires at least 30 threshold selections with zero wrong and must beat deterministic baselines.
- [ ] No runtime integration in this task.

## Non-goals
- Executing rerouted commands during evaluation.
- Letting Jev generate arguments or tool names.
- Treating confidence as authorization for a stronger side effect.
