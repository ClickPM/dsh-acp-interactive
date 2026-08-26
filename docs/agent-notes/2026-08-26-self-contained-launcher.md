# Self-contained editor launcher

Status: implemented

## Decision

Publish a package-owned `dsh-acp-interactive` executable and Cordis composition. Zed starts this executable directly, so installation does not require a DeepSeek Harness source checkout or edits to its example profiles.

The composition owns deployment wiring only. It combines the official agent spine, user settings and credentials, DeepSeek and pi-ai adapters, commands with their domain providers, permissions, persistence, attachments, compaction, and the interactive ACP transport. Domain behavior remains in the owning Harness plugins.

## Consequences

- The package manifest must declare every bare plugin referenced by `config/cordis.yml` as a runtime dependency.
- The shipped launcher must reserve stdout for ACP JSON-RPC frames and resolve its config relative to the installed package.
- A real subprocess test must boot the built launcher outside a Harness checkout and observe both a user-configured provider and the official command catalog.
- Editor configuration points to the installed executable. Source-example launch commands are development-only and must not appear as the installation path.
