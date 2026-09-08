# Upstream-Aligned Product Direction

## Context

Several independent community projects expose DeepSeek Harness as an editor-facing ACP agent. Competing on method count would require this repository to duplicate behavior that Harness already owns or to implement missing Harness domains inside the ACP transport. That direction would weaken the repository's existing ownership boundary, increase coupling to unpublished internals, and make compatibility claims harder to verify.

The project also needs evidence that external reviewers can inspect. Local test results alone do not establish cross-platform package health, and a compatibility matrix derived from Zed source and release notes is not equivalent to a real Zed UI acceptance run.

## Decision

`dsh-acp-interactive` is a composition-first, upstream-aligned distribution of published DeepSeek Harness services. It prioritizes domain ownership, package closure, exact isolation, public CI, upstream reconciliation, and real Zed validation over feature parity with other community implementations.

New capabilities enter only after a stable published Harness Service Definition, Provider, Consumer, and lifecycle closure exists and the editor profile explicitly accepts it. The ACP layer continues to own protocol adaptation, capability negotiation, event projection, output ordering, and request-to-session lifecycle binding, but does not fill upstream domain gaps.

Verification is split into three independent signals:

1. a hermetic release-artifact lane that never uses a Harness checkout;
2. a pinned upstream compatibility lane plus a visible upstream-tip observation lane;
3. versioned Zed contract fixtures plus manual Stable/Preview acceptance reports.

Original project work remains MIT. Retained historical material is handled through a targeted provenance audit and only the notices applicable to material that remains; the project does not restore unrelated historical licensing structure or relicense the whole distribution.

## Alternatives Rejected

- **Match the broadest competing feature set.** Rejected because feature parity is not a stable boundary and would move domain behavior into the transport.
- **Track the complete official Harness profile automatically.** Rejected because an editor profile has different security, lifecycle, and presentation requirements; upstream drift must be reviewed rather than silently changing user behavior.
- **Use only upstream-tip compatibility.** Rejected because a moving target cannot provide a reproducible release guarantee.
- **Treat simulated Zed capabilities as end-to-end validation.** Rejected because protocol compatibility does not prove installation, terminal authentication, or UI presentation in the real client.
- **Restore an entire historical license layout.** Rejected in favor of a file/history-based audit and the minimum notices applicable to retained material.

## Consequences

- Session fork, LSP, unsaved-buffer access, compaction UI, and similar features may remain absent even when another implementation ships them.
- Public CI and compatibility work can delay feature releases.
- The repository must record a known-compatible Harness revision and review every baseline upgrade.
- Upstream-tip failures are visible but do not change the release profile automatically.
- Zed compatibility documentation must identify evidence level and retain failed or untested checklist items.
- Registry positioning should explain the maintenance model and upstream boundary rather than claim the largest feature set.
