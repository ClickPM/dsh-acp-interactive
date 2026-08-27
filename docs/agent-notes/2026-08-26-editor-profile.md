# Editor Profile and ACP Projection Closure

Release `0.7.0` treats the standalone composition as a curated editor profile rather than a copy of the complete official Harness profile. A capability is eligible only when its packages are published, the installed artifact runs without a Harness checkout, the capability is useful in a stdio editor deployment, absence can degrade safely, and its session, connection, agent, cwd, and cancellation ownership can be preserved.

## Decision

The profile adds `@deepseek-ai/dsh-tool-fs-search`. Its packaged ripgrep binary provides `glob` and `grep` without a system executable or external account, resolves work relative to the exact agent session cwd, forwards the tool-call signal through the subprocess seam, and owns `presentCall`, `presentResult`, and durable `presentationMeta`. The profile also composes `@deepseek-ai/dsh-tool-call-timeout-policy`, so the tool's declared cooperative deadline settles only after the subprocess has quiesced. Spill remains an optional Harness-internal provider and is not advertised through ACP.

The existing goal selection is retained as a complete pairing: `agent-spine-demo` owns the goal Service Definition, provider, round driver, and model tools, while `command-goal` is the human consumer. ACP discovers `/goal` only through the command registry. The transport contains no command list and no filesystem-search implementation; both capabilities use their owning Harness packages and the generic ACP projection path.

Web, LSP, persistent terminals, subagents, and workflows remain deferred. Web requires an explicit external-provider and diagnostic review. LSP and persistent terminals need process/output teardown review. Subagents and workflows require ACP cancellation, settlement, late-event suppression, and connection-teardown coverage before inclusion. Spill, pruning, timeout, and loop-guard policies remain internal even when a selected tool consumes them.

## Reconciliation and closure

`config/editor-profile.json` is the review record. `npm run check:profile` compares the checked-in Cordis composition with its manifest, verifies every bare plugin and selected package is a direct runtime dependency, scans the official reference composition for actual `ctx.commands.register()` calls, and reports additions/removals in candidate packages, human commands, required providers, and critical consumers. Drift fails the check but never mutates the published composition.

`npm run verify:packed` packs the repository, installs the tarball in a temporary directory outside both repositories, resolves every package referenced by the installed Cordis profile plus the packaged ripgrep binary, and boots the installed launcher through a real ACP initialize/new-session exchange. Real launcher tests additionally execute `/goal` and a model-issued `glob` call, verifying generic ACP cards and the result projected from persisted presentation metadata.
