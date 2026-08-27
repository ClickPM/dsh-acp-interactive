# Additional Directories Capability Boundary

## Decision

`dsh-acp-interactive` will not implement the Additional directories domain capability. ACP v1 already supplies the request fields and capability vocabulary, but the current Harness composition resolves one immutable session `cwd` into one `SandboxExecutionPolicy.workspaceRoot`. Filesystem mutation fencing, shell confinement, platform sandbox providers, observation ownership, and model-visible policy context all share that single-root contract.

Accepting non-empty `additionalDirectories` in the transport before those owners share an exact multi-root policy would advertise a false capability. Mapping roots to a common parent would authorize unrelated siblings, and widening operations to `danger-full-access` would remove the requested boundary. Both approaches are rejected.

The independent sibling project `dsh-additional-directories` owns the proposed Harness-side Service Definition, registry, policy resolution, enforcement-provider integration, and lifecycle. Its initial design treats roots as live session configuration supplied again on create/load/resume, avoiding an immediate durable `SessionHeader` format change.

## Consequences

This repository continues to reject non-empty `additionalDirectories` until a complete, published companion capability is composed. Its roadmap no longer schedules Additional directories; the next integration stage is session-scoped MCP. A future bridge integration may validate ACP paths, install the root set before agent publication, advertise the capability only after complete composition, and await the companion's teardown, but it will not own multi-root enforcement behavior.
