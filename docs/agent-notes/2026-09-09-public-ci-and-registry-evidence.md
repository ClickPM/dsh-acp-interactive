# Public CI, Release Workflow, and Registry Evidence

## Context

The ACP Registry submission (agentclientprotocol/registry#585) points reviewers
at this repository and at the npm package. Until now the GitHub repository had
no workflows, no releases, a Chinese default README, and a Chinese npm
description, while every verification claim in the PR rested on a local run.
[Upstream Alignment](../upstream-alignment.en.md) already ranks public
cross-platform CI (Q1) and release/Registry evidence (Q4) ahead of feature
work; this note records how they land.

## Decision

- `README.md` is the English document and `README.zh.md` the Chinese one.
  GitHub and npm render the English file by default; both files remain
  complete counterparts and change together.
- `.github/workflows/ci.yml` runs on every push and pull request across
  Ubuntu, macOS, and Windows with Node `22.19` and `24`: `npm ci`, typecheck,
  build and tests, pack dry run, the packed-install launcher verification, and
  a whitespace check. Official-checkout reconciliation (`check:profile`,
  `test:harness`) stays outside this lane until Q2 pins an upstream revision.
- `registry/agent.json` plus the root `icon.svg` are the canonical Registry
  entry. `scripts/check-registry-entry.mjs` re-implements the Registry's id,
  version, package, and icon rules against `package.json`, and
  `.github/workflows/registry-auth.yml` stages that entry into a fresh clone of
  `agentclientprotocol/registry` and runs the Registry's own
  `build_registry.py --dry-run` and `verify_agents.py --auth-check`. It runs
  daily, on demand with an explicit version, and is dispatched by the release
  workflow after it publishes a version (a Release created with
  `GITHUB_TOKEN` does not fire `release: published` for other workflows, so
  the dispatch is explicit; after a manual npm publish, run
  `gh workflow run registry-auth.yml -f version=<x.y.z>` by hand). The
  submission is thus re-validated with the maintainers' scripts rather than a
  local approximation.
- `.github/workflows/release.yml` runs on `v*.*.*` tags. It verifies the tagged
  tree, packs the tarball, publishes through npm trusted publishing only when
  the repository variable `NPM_TRUSTED_PUBLISHING` is `true`, and creates the
  GitHub Release with the tarball and `SHA256SUMS.txt`. Ordinary CI holds no
  publishing credential; the publish step is idempotent when the version
  already exists on npm.

## Why

Registry maintainers merge from a short checklist and public links. A green
matrix, a Release page, and a workflow that runs the Registry's own validator
answer "does it install, does it authenticate, is it maintained" without
requiring them to run anything. Keeping the Registry entry in this repository
makes the submitted file reproducible and lets CI exercise exactly what the PR
contains.

Trusted publishing is gated behind a variable instead of enabled by default so
that tagging before the npm trusted publisher is configured does not produce a
failed release run; the tarball and Release still appear, and the same tag can
be published later without changes.

## Findings from the first cross-platform run

Running the release lane in clean Ubuntu containers (Node 24 and 22.19)
before publishing the workflows exposed three Windows-only assumptions that a
local Windows run could not show:

- `tests/presentation.spec.ts` hardcoded `C:\...` fixtures, so
  `node:path`-based title shortening and cwd resolution behaved differently on
  POSIX. Fixtures now derive from the running platform's root.
- Two real-launcher tests wrote `.credentials.yaml` with the default umask;
  `@deepseek-ai/dsh-credentials-local` correctly refuses a credentials file
  readable beyond its owner, which surfaced as "owner disposed during setup".
  The tests now write the file with mode `0600`.
- `scripts/verify-packed-install.mjs` located `npm-cli.js` through the Windows
  install layout. It now uses `npm_execpath` with a per-platform fallback.

Runtime code did not change; the ACP Registry auth check against the
published `1.0.3` package passed in the same containers (cold cache, 67 s).

## Consequences

- `package.json` `files` ships `README.md` and `README.zh.md`; `README.en.md`
  no longer exists and external links to it must use `README.md`.
- The Registry entry's `version` tracks the version currently submitted or
  listed, not necessarily `package.json`; `registry-auth.yml` accepts an
  explicit version to probe a newer release before the entry is bumped.
- Activating trusted publishing requires configuring GitHub Actions as a
  trusted publisher for `deepseekharness-acp-interactive` on npmjs.com
  (repository `ClickPM/dsh-acp-interactive`, workflow `release.yml`) and
  setting `NPM_TRUSTED_PUBLISHING=true`.
- Q0 (provenance audit), Q2 (pinned upstream lane), and Q3 (real Zed
  validation) remain open and are not claimed by this change.
