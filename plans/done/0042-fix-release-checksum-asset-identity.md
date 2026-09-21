---
id: TASK-0042
title: Fix release checksum asset identity
status: done
depends_on: []
priority: high
tags: []
---

# Fix release checksum asset identity

## Problem
The first v0.0.1 release quality gate generated SHA256SUMS with a .release/ path while the publisher correctly requires the release asset basename, so publication stopped before any remote artifact upload. Generate canonical basename-only checksums and test the real workflow command.

## Context
(Optional: approach, links, related tasks.)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes

