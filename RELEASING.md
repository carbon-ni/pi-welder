# Releasing pi-welder

`@carbon-ni/pi-welder` publishes through GitHub Actions. The release artifact is
built and verified once, then published unchanged.

## Prerequisites (one-time, by a maintainer)

1. The repository is `carbon-ni/pi-welder` and the package name is
   `@carbon-ni/pi-welder` with `publishConfig.access: "public"`.
2. npm trusted publishing is configured for the npm package: publisher
   `GitHub Actions`, repository `carbon-ni/pi-welder`, workflow `release.yml`,
   environment left empty. **No npm token is stored in the repository**, and
   none is required: the publish job exchanges its GitHub OIDC token for a
   short-lived npm credential and attaches provenance automatically.
3. The workflow needs its default permissions only, plus `id-token: write` for
   OIDC and `contents: write` to attach assets to the Release. Both are declared
   in `.github/workflows/release.yml`.
4. The `gh` CLI must be available in the runner (GitHub-hosted runners include
   it) and `GITHUB_TOKEN` must be able to write Release assets.

## Trigger

`release.published` is the **only** publication trigger. Nothing else publishes:
not pushes to `main`, not tags alone, not a manual workflow run.

1. Merge to `main` with a green CI run — CI executes the same
   `make all` plus `make package-verify` gates that the release quality gate
   runs.
2. Set `package.json` `version` to the intended release version. A stable
   version publishes under the npm `latest` tag; a version containing a
   prerelease suffix publishes under `next`.
3. Create the tag `v${package.json.version}` and a GitHub Release for it. The
   release name must not be empty: the publish job rejects an empty name and any
   tag that is not exactly `v` + the package version.

Creating a tag, a Release, or running the workflow is an explicit maintainer
action. The automation itself never creates remote state.

## What runs

**Quality gate** (job `quality-gate`, checked out at the release tag):

- `npm ci`, then `make all` — lint, extension tests, script tests;
- `npm pack --pack-destination .release` — exactly one tarball, no rebuilds;
- `sha256sum` into `.release/SHA256SUMS`;
- `PACKAGE_TARBALL=<tarball> npm run verify:package` — verifies **that** tarball:
  identity, contents against the runtime import closure, isolated pinned-peer
  consumer install, load through the real Pi host loader, and a real `pi`
  process started with the packed extension offline;
- uploads the tarball and `SHA256SUMS` as the `release-artifact` workflow
  artifact.

**Publish** (job `publish`, only when the gate succeeded):

- downloads `release-artifact` — it never repacks, so the published bytes are
  the verified bytes;
- re-checks tag identity and that the Release name is not empty;
- runs `scripts/release-publish.mjs`, which:
  - publishes to npm with provenance when the version is absent;
  - skips npm when the existing version is **byte-identical** and fails when it
    differs;
  - uploads the tarball and `SHA256SUMS` to the GitHub Release, with the same
    identical-or-fail rule.

## Evidence to check afterwards

- npm: the version exists, the tarball digest equals `.release/SHA256SUMS`, and
  the provenance attestation shows this workflow and commit.
- GitHub: the Release carries the `.tgz` and `SHA256SUMS` assets, and their
  digests match.
- Actions: the `release-artifact` uploaded by the gate is the artifact the
  publish job downloaded.

## Rerun and partial failure

Rerunning the workflow is safe and is the intended recovery path.

| Situation | Behavior |
| --- | --- |
| Publish job failed before npm publish | Rerun; npm publish happens then. |
| npm succeeded, GitHub upload failed | Rerun; npm is byte-identical and skipped, the upload completes. |
| Everything succeeded | Rerun; both destinations are byte-identical and skipped. |
| Tarball bytes differ from a published version | The run **fails loudly**. Never delete and republish to force it: bump the version instead. |
| Tag `v…` does not match `package.json` | The run fails before any remote call. |
| Quality gate failed | Publish is skipped entirely (`needs` + result check). |
| npm authentication or network error | The run fails; nothing is uploaded to GitHub afterwards, so a rerun resumes cleanly. |

The workflow uses `concurrency: release-${tag}` with
`cancel-in-progress: false`, so two runs for one release queue instead of
racing.

## Local dry run

No remote state is touched by these commands:

```bash
make all                 # lint + extension tests + script tests
make package-verify      # pack once, isolated consumer, real Pi host load
npm pack --dry-run       # inspect the exact file list
```

Publishing from a workstation is intentionally unsupported: provenance and OIDC
come from the workflow identity.
