---
id: TASK-0041
title: Add deterministic npm and GitHub release process
status: doing
depends_on: []
priority: high
tags: [release, npm, github, package, oidc, verification]
---

# Add deterministic npm and GitHub release process

## Problem
pi-welder is public on GitHub but private/unscoped in package metadata and has no release automation. Adapt pi-bebop's deterministic release contract for `@carbon-ni/pi-welder` with MIT licensing, isolated Pi-package verification, one canonical tarball, GitHub Release authorization, npm OIDC publishing, checksums, and resumable byte-identity checks.

## Decisions
- Public package: `@carbon-ni/pi-welder`.
- License: MIT, matching pi-bebop.
- GitHub `release.published` is the sole publication trigger.
- Creating automation does not authorize a tag, GitHub Release, npm publication, push, or credential change.

## Acceptance criteria
- [ ] Package metadata is publishable, scoped, discoverable as a `pi-package`, points to `carbon-ni/pi-welder`, and uses Pi's documented peer dependency contract for host-provided packages.
- [ ] Package contents are explicitly bounded to runtime source, README, license, and manifest; tests, plans, logs, local config, scripts, and evaluation artifacts do not ship.
- [ ] `verify:package` builds one tarball, checks identity/contents, installs it into an isolated consumer with pinned Pi peers, loads the extension through the real Pi host offline, and rejects leaked or missing files.
- [ ] Release quality gate runs deterministic checks, packs once, verifies that exact tarball, creates SHA-256, and uploads only the tarball and checksum as a workflow artifact.
- [ ] Publish job requires successful quality gate, tag `v${package.version}`, and non-empty release name; stable uses npm `latest`, prerelease uses `next`.
- [ ] npm uses trusted publishing/OIDC with provenance; no long-lived npm token is introduced.
- [ ] The exact verified tarball is published to npm and attached to the GitHub Release; reruns skip byte-identical destinations and fail on mismatches.
- [ ] Publish logic has behavioral tests for new, resumed, mismatched, invalid-tag, failed-gate, stable/prerelease, authentication/network, and malformed registry responses.
- [ ] CI runs the same package/check gates on pull requests and main before release.
- [ ] `README.md` documents installation and current Jev read-path behavior accurately; `RELEASING.md` documents operator prerequisites, trigger, evidence, rerun, and partial-failure procedure.
- [ ] No remote release state is created or modified.
