# AGENTS.md

`dsh-acp-interactive` is an independent editor-facing ACP server assembled from published DeepSeek Harness packages. Read [docs/design.md](docs/design.md), [docs/roadmap.md](docs/roadmap.md), and the owning source before changing behavior.

## Architecture

- Keep domain behavior in the owning Harness plugins. This repository owns ACP adaptation, event projection, package composition, and its standalone launcher.
- The installed package must run without a DeepSeek Harness source checkout. A checkout is a development-only compatibility fixture.
- Every optional ACP capability is advertised only when its complete Harness services are composed and the client declares required support.
- Preserve exact session, connection, agent, working-directory, skill, approval, model-selection, and cancellation isolation.
- Model-visible content is durable in the Harness session log before request assembly. UI-only ACP updates never enter model context.
- `config/cordis.yml` and `package.json` move together: every bare plugin is a runtime dependency, and commands include their domain providers rather than command adapters alone.

## Development

- Use the Node range and npm lockfile declared by this repository. Do not create workspace junctions or depend on a sibling checkout at runtime.
- Run `npm test`, `npm run typecheck`, `npm run test:harness`, `npm pack --dry-run`, and `git diff --check` for non-trivial runtime changes. `DSH_HARNESS_ROOT` selects the official checkout; without it, `test:harness` uses the sibling `../deepseek-harness` directory.
- `npm run test:harness` extracts the official ACP specs from the pinned ref in `config/upstream-baseline.json` into an ignored temporary directory and runs the assertions classified there as aligned against this repository's `src`. Every official spec must be classified as aligned or divergent; an unclassified or vanished spec fails as `fixture unavailable`. Never edit the official checkout, and never reclassify a spec to keep the gate green, to make compatibility tests pass.
- Maintain 100% per-file coverage for affected runtime source, plus real built-launcher ACP tests for composition, commands, provider discovery, cancellation, and multi-session isolation.
- Update Chinese and English README or roadmap counterparts together. Non-trivial architecture or lifecycle decisions require an Agent Note under `docs/agent-notes/`.
- Never commit credentials, generated coverage, temporary official tests, session data, or package archives. Stdout is reserved for ACP JSON-RPC frames.

## Release

- Keep package version, manifest, lockfile, packaged configuration, docs, and local installation instructions consistent.
- Verify a packed installation from outside this repository before publishing a behavior release.
- Tags `v*.*.*` run `.github/workflows/release.yml`; npm publishing uses trusted publishing gated by the `NPM_TRUSTED_PUBLISHING` repository variable. Never add a publishing token to CI.
- `registry/agent.json` and `icon.svg` are the canonical ACP Registry entry; run `npm run check:registry` whenever either changes.
- Do not commit or push unless the user explicitly requests it.
