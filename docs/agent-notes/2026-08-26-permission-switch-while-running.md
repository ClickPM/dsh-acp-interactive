# Permission switch accepted while the session is running

Status: implemented

## Decision

`session/set_config_option` for the ACP permission selector no longer refuses a running session. Previously the bridge rejected the switch with `permission configuration cannot change while the session is running`, which left the editor dropdown unable to change permission once any prompt had started. Zed applies its stored `default_config_options` (for example `permission: danger-full-access`) right after `session/new`; any later dropdown change therefore failed while a turn was in flight, and the UI value diverged from the real sandbox/approval policy.

The switch still executes the existing `/permission` write path: the preset, sandbox mode, and approval policy events commit to the session log immediately, and the sandbox and approval services fold them at the next operation boundary. A running step keeps its already-assembled context; subsequent confined calls and approval requests observe the new policy. After the switch the bridge also publishes a full `config_option_update`, so the client selector tracks the committed state.

## Consequences

- `src/index.ts` no longer checks agent status or in-flight state for permission configuration; the serialized per-session config queue and the `configuring` guard still prevent a prompt from passing an unsettled switch.
- The bridge now publishes `config_option_update` after a selector-initiated permission change, matching the existing behavior for direct `/permission` commands.
- `tests/bridge.spec.ts` (this repository and the official Harness compatibility copy) asserts that a running switch succeeds, returns the updated selector value, and emits `config_option_update`.
- README (zh/en) and `docs/design.md` describe the running-session switch semantics instead of the refusal.
