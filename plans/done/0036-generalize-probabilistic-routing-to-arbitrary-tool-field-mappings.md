---
id: TASK-0036
title: Generalize probabilistic routing to arbitrary tool field mappings
status: done
depends_on: [TASK-0033, TASK-0034, TASK-0035]
priority: high
tags: [routing, schemas, field-mapping, jeq, shadow, generalization]
---

# Generalize probabilistic routing to arbitrary tool field mappings

## Problem
Agents can hallucinate arbitrary argument keys for any tool, not only bash command aliases. We need a schema-driven planner that enumerates bounded target-tool and field-mapping hypotheses using unchanged values, then lets Jev judge intent while deterministic validation and capability policy retain control.

## Desired outcome
A generic, shadow-only evaluator for malformed calls that asks: which target tool and which one-to-one field mapping best explains the agent's intent? The planner works from active verified tool schemas, not a fixed alias vocabulary.

## Method

1. Capture the attempted tool, original top-level key/type shape, bounded prior signals, and active tool schemas.
2. For each supported target schema, enumerate one-to-one mappings from original fields to canonical schema fields with compatible value types.
3. Keep only plans that use every input field, satisfy all required target fields, require no invented value, and deterministically revalidate.
4. Bound to five input fields, five target tools, and five total mapping hypotheses plus `none`; unsupported schema constructs fail closed.
5. Exact canonical schema match remains deterministic and bypasses Jev.
6. Jev selects a `{target tool, mapping ordinal}` hypothesis using safe key tokens, canonical role names, value-shape features, and prior intent signals. Values remain local and unchanged.
7. Correlate with a bounded later successful tool call and its field/value mapping as hidden ground truth.

## Acceptance criteria
- [ ] Support verified schemas for `read`, `write`, `edit`, and `bash`; design schema extraction so additional simple object schemas can be added without alias lists.
- [ ] Correctly enumerate examples such as `fileName → read.path`, `destination/body → write.path/content`, `file/replacements → edit.path/edits`, and `execute → bash.command`.
- [ ] Mappings are bijective over supplied fields and candidate target fields; no input value is generated, transformed, duplicated, or dropped.
- [ ] Candidate arguments validate against the target schema before a hypothesis exists and again after selection.
- [ ] Requests contain only safe key tokens, value types/closed shape features, attempted tool, target tool IDs, canonical role names, mapping ordinals, and bounded prior signals; no raw values, paths, commands, source, credentials, conversation, or future behavior.
- [ ] Report corpus attrition, labelability, candidate-set coverage/recall, mapping ambiguity, tool-pair distribution, session concentration, deterministic baselines, and Jev accuracy/calibration/abstention at >=0.90 and >=0.99.
- [ ] Use installed `jeq`, zero retries, hardened parsing; no call if fewer than 30 labelable cases or privacy fails.
- [ ] Runtime behavior is shadow-only: selected hypotheses never mutate, reroute, read, write, edit, or execute.
- [ ] Future promotion requires >=30 threshold selections with zero wrong, coverage >=0.95 for eligible calls, deterministic revalidation, and explicit capability policy for the selected source/target pair.

## Non-goals
- Maintaining a comprehensive alias dictionary.
- Supporting recursive/union schemas in the first iteration.
- Letting Jev invent arguments, values, tools, or mappings.
- Enabling probabilistic execution before calibration.
