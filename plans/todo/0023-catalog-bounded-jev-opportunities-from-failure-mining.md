---
id: TASK-0023
title: Catalog bounded Jev opportunities from failure mining
status: doing
depends_on: []
priority: high
tags: [typesafe, mining, evidence, roadmap, safety]
---

# Catalog bounded Jev opportunities from failure mining

## Problem
We have three open Jev threads (label collection, rule routing, read-failure suggestions) but no shared evidence base ranking which failure classes a bounded classifier can actually help with. Decisions are being made per-task on intuition; a single mined catalog of attempt-shapes versus arrived-shapes would let us rank opportunities by frequency, recoverability, and safety shape before building anything else.

## Desired outcome
A ranked catalog of failure classes from real logs. Each entry states: frequency, one canonical sample (redacted), what the agent appears to have attempted versus the shape that arrived, whether bounded deterministic candidates + postchecks exist, and a safety-shape verdict (select-among-deterministic / disambiguate / generate — generate is refused). The catalog drives which follow-up tasks get built and in what order.

## Context
Procedure: use the pi-welder-mine skill (`.pi/skills/pi-welder-mine/SKILL.md`) — run its script from the project root, then extend the ranked clusters with the attempt-vs-arrived analysis. Serves TASK-0021 (routing dataset), TASK-0022 phase 1 (read shapes), and any future selector.

Governance line (predeclared, unchanged): automatic application requires deterministic candidates plus deterministic postchecks plus a predeclared precision gate with reviewed labels. Classifier confidence alone never overrides a failing check; classifiers never generate arguments, paths, or content.

## Acceptance criteria
- [ ] Mine script run over both sources (pi + welder logs); summary lines captured.
- [ ] Top clusters ranked by frequency with counts; execution noise (bash non-zero exits) separated from structural clusters.
- [ ] For each structural cluster: attempt-shape hypothesis, arrived-shape, and whether deterministic candidate+postcheck machinery exists today.
- [ ] Each cluster mapped to a safety shape: rule-routing, candidate-disambiguation, or refused (generation).
- [ ] Redacted samples only — no paths, secrets, or source content beyond what the mine report already truncates.
- [ ] Catalog ends with a PO-ready ranking: top 3 opportunities with the evidence gate each must pass before runtime use.
- [ ] Cross-links to TASK-0021/0022 datasets noted where clusters overlap.

## Non-goals
- Writing any repair rule or runtime behavior in this task.
- Sending anything to the TypeSafe API — offline analysis only.
- Replacing the promotion gates.
