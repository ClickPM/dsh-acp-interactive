# Home Sessions Root

## Decision

Release `1.3.2` changes the packaged `dsh-session-persistence-jsonl` root from `./.sessions` to `dshHomePath('acp-sessions')`. `DSH_ACP_SESSIONS_ROOT` still overrides it; a blank value now falls back to the default instead of resolving to the process directory.

## Why the process directory was wrong

The persistence backend resolves its root once, when the plugin starts, and then files every log under `<root>/<projectKey(session cwd)>/<sessionId>/`. ACP gives each session its own absolute `cwd`, and the composition already scopes sandbox policy, filesystem fencing, tools, skills, and MCP servers to that `cwd`; the `process.cwd()` values elsewhere in `cordis.yml` are only fallbacks for calls that have no session. The sessions root was the one place where the process directory still decided behavior, and it decided only which histories a process could see.

An ACP client may serve several workspaces from one server process, or restart the server with a different working directory. Both happen in practice: a desktop client that started the server in workspace A and later created sessions in workspace B wrote B's logs under A's `.sessions`; after a restart in B, `session/load` failed with `session not found` for those same sessions. Launch directories also collected untracked `.sessions` folders that were easy to commit by accident.

## Why the dsh home, and why a separate directory

Settings and credentials already live in the dsh home, and the Harness bundle files its own sessions at `dshHomePath('sessions')`. `dsh-app-boot` provides `dshHomePath` to the loader scope, so the packaged profile can use the same helper, and `$DSH_HOME` moves sessions together with the rest of the user's state.

ACP sessions stay in `acp-sessions` rather than sharing `sessions`. This package composes its own pinned Harness baseline, which need not match the version another Harness surface on the same machine runs, and the README already promises that those surfaces keep isolated sessions.

## Consequences

Existing logs under any `.sessions` directory are neither moved nor read. Users who want them keep the old location through `DSH_ACP_SESSIONS_ROOT`, or move the project directories into the new root; the layout beneath the root is unchanged. A real launcher test writes a session from one process directory and restores it from a second launcher started in another directory, asserting that neither directory gains a `.sessions` folder.
