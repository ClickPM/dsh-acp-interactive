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
- `npm run test:harness` copies the current official `packages/acp/acp-interactive/tests` into an ignored temporary directory and runs those assertions against this repository's `src`. Never edit the official checkout to make compatibility tests pass.
- Maintain 100% per-file coverage for affected runtime source, plus real built-launcher ACP tests for composition, commands, provider discovery, cancellation, and multi-session isolation.
- Update Chinese and English README or roadmap counterparts together. Non-trivial architecture or lifecycle decisions require an Agent Note under `docs/agent-notes/`.
- Never commit credentials, generated coverage, temporary official tests, session data, or package archives. Stdout is reserved for ACP JSON-RPC frames.

## Release

- Keep package version, manifest, lockfile, packaged configuration, docs, and local installation instructions consistent.
- Verify a packed installation from outside this repository before publishing a behavior release.
- Do not commit or push unless the user explicitly requests it.
