# Self-contained editor launcher

Status: implemented

## Decision

Publish a package-owned `dsh-acp-interactive` executable and Cordis composition. Zed starts this executable directly, so installation does not require a DeepSeek Harness source checkout or edits to its example profiles.

The composition owns deployment wiring only. It combines the official agent spine, user settings and credentials, DeepSeek and pi-ai adapters, commands with their domain providers, permissions, persistence, attachments, compaction, and the interactive ACP transport. It disables the spine's bundled bash consumer and selects matching executor and tool pairs at process start: PowerShell on Windows, Bash on Linux and macOS. Domain behavior remains in the owning Harness plugins.

## Consequences

- The package manifest must declare every bare plugin referenced by `config/cordis.yml` as a runtime dependency.
- Exactly one shell executor and model-facing shell tool is active. This prevents Windows PATH resolution from selecting the WSL `bash.exe` launcher and keeps tool syntax aligned with its executor.
- The shipped launcher must reserve stdout for ACP JSON-RPC frames and resolve its config relative to the installed package.
- A real subprocess test must boot the built launcher outside a Harness checkout and observe both a user-configured provider and the official command catalog.
- Development runs the current official Harness ACP tests against this repository's source from a read-only checkout; that checkout never enters the installed package or launcher path.
- Editor configuration points to the installed executable. Source-example launch commands are development-only and must not appear as the installation path.
