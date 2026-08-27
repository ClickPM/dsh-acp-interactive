# dsh-acp-interactive Development Roadmap

[中文](roadmap.md) | English

This reference defines the recommended development order for `dsh-acp-interactive` after the self-contained Zed integration. ACP owns editor-agent communication fields and lifecycle methods; this plugin owns protocol adaptation and Cordis composition; DeepSeek Harness continues to own model, tool, skill, permission, persistence, and agent-loop behavior.

## Current Baseline

Version `1.0.0` establishes the current self-contained ACP v1 integration as the stable baseline: Stages A, B, C, and D1 are complete, with coverage for session-scoped MCP, successful-close durability, concurrent list/load/resume/close isolation, and real two-process JSONL recovery. The standalone launcher also composes Harness's first-prompt LLM title provider, which publishes a durable asynchronous title after the immediate fallback. Stage E is `Deferred`. Additional directories remains explicitly unsupported.

Production uses ACP v1. The plugin advertises an optional protocol capability only when the client declares support and the assembled Harness services implement it completely.

## Capability Integration Boundary

This repository does not implement DeepSeek Harness domain capabilities. Web access, file search, LSP, terminals, subagents, workflows, spill, tool-result pruning, timeouts, loop guards, and their execution semantics, policies, and domain events remain owned by their Harness plugins. This repository owns only two kinds of work: composing published Harness plugins that are suitable for an editor into the standalone launcher with a complete install/runtime dependency closure, and reliably exposing the requests, events, and lifecycle those plugins already provide to Zed through generic ACP protocol surfaces.

Multi-root registration, sandbox policy, and cross-capability enforcement for Additional directories belong to the independent `dsh-additional-directories` DSH plugin project, not this repository. Until that project provides a complete published Service Definition, Provider, and Consumer closure, this bridge continues to reject non-empty `additionalDirectories` explicitly and makes no release commitment for the capability in this roadmap.

Capabilities enter the integration under these rules:

- model-facing tools use presentation metadata from the Harness tool registry and map to generic ACP `tool_call` / `tool_call_update` messages by default; the transport does not reimplement behavior based on tool names;
- human commands are discovered only from plugins that actually call `ctx.commands.register()`; model-only tools are never presented as slash commands;
- ACP-specific adaptation is added only for client interaction or lifecycle concerns such as approval, structured elicitation, incremental terminal output, cancellation, restore, and teardown;
- Harness-internal policies such as spill, pruning, timeouts, and loop guards are not advertised as ACP capabilities; ACP projects only their visible results and explicit failures;
- the standalone launcher maintains a curated editor profile rather than mechanically copying the complete official profile. Official-profile reconciliation reports additions, removals, and dependency differences, but inclusion remains an explicit decision based on publication status, editor value, protocol expressibility, and isolation requirements.

## Stage A: Align with the Latest Stable ACP v1

Status: completed in `0.6.0`. See the [ACP v1 Agent Note](agent-notes/2026-08-26-acp-v1-baseline.md) and [Zed compatibility matrix](compatibility.en.md) for implementation and compatibility boundaries.

### Objective

Remove the gap between the older SDK and the latest stable v1 protocol so later work builds on stable types and compatibility rules.

### Deliverables

- Upgrade `@agentclientprotocol/sdk` to stable 1.x and adopt its schema, naming, and capability-negotiation changes;
- migrate form elicitation from the unstable capability to the stable protocol;
- support stable message IDs, request cancellation, session usage/context/cost, model config categories, and boolean config options;
- add protocol schema conformance tests and a compatibility matrix for supported Zed versions;
- leave unimplemented stable capabilities unadvertised or reject them explicitly instead of accepting them through permissive parsing.

### Acceptance

- Type checking, protocol tests, and real Zed initialization pass with the latest stable ACP SDK;
- new, load, resume, cancellation, elicitation, and configuration updates retain current session isolation;
- initialization advertises only capabilities verified through the real composition.

## Stage B: Establish the Editor Profile and ACP Projection Closure

Status: completed in `0.7.0`. See the [Editor Profile Agent Note](agent-notes/2026-08-26-editor-profile.md) for the review and lifecycle decisions and [`config/editor-profile.json`](../config/editor-profile.json) for the machine-checked manifest.

### Objective

Define a Harness editor profile for the standalone launcher and verify that each selected published capability works reliably through generic ACP projection, cancellation, and lifecycle management. This stage neither implements nor copies Harness domain capabilities in this repository, and it does not aim to cover the complete official profile.

### Deliverables

- define editor-profile admission rules: a capability must be independently published, run without a Harness checkout, suit a stdio editor deployment, degrade safely, and preserve session, connection, agent, cwd, and cancellation isolation;
- use the official bundle/profile and actual plugin source as references for candidate capabilities and dependency relationships, automatically reporting additions, removals, required providers, and critical-consumer differences without copying the composition or changing defaults automatically;
- compose the complete Service Definition, Provider, Consumer, and lifecycle policy for every selected existing Harness capability; satisfying the admission rules makes a published package eligible but does not include it automatically, so web search/fetch, enhanced file search, LSP, persistent terminals, subagents, and workflows still require explicit review and selection;
- project model-facing tools through the generic ACP tool-card path using Harness `presentCall`, `presentResult`, and `presentationMeta`; add specialized projection only when ACP/Zed provides a stable and materially useful representation;
- expose only human commands whose plugins actually call `ctx.commands.register()`, without a handwritten command list and without presenting model-only tools as slash commands;
- add only ACP-specific cancellation, settlement, late-event suppression, and teardown handling for persistent terminals, subagents, and workflows; spill, tool-result pruning, timeouts, and loop guards remain Harness-internal policies;
- add package dependency closure, Cordis Loader, packed-install runtime closure, and editor/official-profile difference checks.

### Acceptance

- a clean installation loads the reviewed editor profile and its complete dependency closure outside a Harness checkout; missing optional external providers are diagnosed explicitly without advertising unsupported capabilities;
- reconciliation reports official-profile changes to candidate capabilities, human commands, required providers, and critical consumers without changing the published composition before review;
- real ACP flows execute at least one newly selected human command and model-facing tool; if the editor profile includes subagents, workflows, or persistent terminals, their cancellation, settlement, and teardown paths are each covered;
- the transport contains no domain implementation for web, LSP, subagents, workflows, spill, pruning, timeouts, or loop guards, and tools without a dedicated ACP representation use the generic projection;
- multiple sessions, connections, and Zed processes do not share derived state or cancellation signals.

## Stage C: Session-Scoped MCP

Status: completed in `0.8.0`. See the [Session-Scoped MCP Agent Note](agent-notes/2026-08-27-session-scoped-mcp.md) for the isolation, startup-transaction, and teardown decisions.

### Objective

Accept MCP server configuration supplied by Zed and adapt the published Harness MCP client capability into a live composition owned by the exact session.

### Deliverables

- own an independent MCP server lifecycle, tool registration, and teardown for each session;
- apply the same agent-scope checks to MCP tools and approvals that existing commands, skills, and tools use;
- define failures for unsupported MCP transports, startup failure, cancellation, and configuration changes during resume.

### Acceptance

- One session's MCP tools, configuration, and failures never enter another session;
- load and resume use only the complete MCP configuration in the current request without inheriting another connection's live state;
- connection closure, session close, and cancellation await complete quiescence of MCP calls, reconnect work, tool registrations, and child processes.

## Stage D: Complete Session Management

Status: D1, “Session lifecycle reliability,” is complete in `0.8.1`; Stage D as a whole remains incomplete. The transport will not substitute for unavailable DSH deletion, metadata-pagination, or `updatedAt` capabilities, and ACP session fork still waits for a stable protocol and Zed support. See the [Session Lifecycle D1 Agent Note](agent-notes/2026-08-27-session-lifecycle-d1.md) for the lifecycle decision.

### Objective

Complete discovery and deletion for large session histories while preserving derived-index consistency.

### Deliverables

- Add a backend-independent delete operation to the Harness persistence capability before implementing ACP `session/delete`;
- add stable opaque cursors, pagination, and authoritative `updatedAt` values to `session/list`;
- reconcile deletion across the JSONL source of truth, attachments, checkpoints, and session-query derived indexes;
- project Harness session forks after ACP session fork stabilizes and Zed supports it;
- D1 adds concurrent list/load/resume/close, same-session restore exclusion, a close durability barrier, and real multi-process JSONL recovery coverage; concurrent delete coverage remains deferred with deletion itself.

### Acceptance

- The ACP transport never implements deletion by editing JSONL files or private SQLite tables;
- cursors remain deterministic when sessions are added or updated during pagination, without silent duplicates or omissions;
- close releases live resources and delete removes durable history; the two operations retain separate semantics.
- D1 guarantees that a successful close crosses the standard session flush before returning, so another already-running launcher sharing the JSONL source but owning a private derived index can immediately list/load/resume it; a checkpoint failure still releases live resources and fails explicitly.

## Stage E: Rich Content and Real-Time UI

Status: `Deferred`. Core ACP v1 usage does not depend on this stage. Re-evaluate it only when there is concrete editor demand and the corresponding ACP/Zed surface and Harness domain capability have a complete lifecycle. This status does not prevent correctness fixes to existing projections.

### Objective

Improve Zed presentation for long-running work, terminals, and multimedia results.

### Deliverables

- Stream terminal output incrementally while retaining a text fallback for clients without the extension;
- admit, persist, validate against model modalities, and replay audio and embedded resources;
- project tool-result images and complete diff states such as deleted files;
- adopt plan operations, session compaction, and session notices after the corresponding ACP features stabilize and Zed supports them;
- make large-content limits configurable and reuse Harness spill and compaction providers.

### Acceptance

- Streaming terminal, image, and resource updates cannot arrive late after cancellation or connection closure;
- content that cannot be persisted and replayed without loss fails explicitly instead of producing incomplete history;
- rich content remains owned by the selected model route, session log, and attachment store.

## Cross-Cutting Requirements

Every stage preserves these rules:

- Domain behavior remains in its owning Harness plugin; the ACP transport performs only protocol adaptation, capability negotiation, and event projection;
- each capability has a complete Service Definition, Provider, and Consumer composition, and missing prerequisites either fail loading or suppress advertisement;
- sessions, connections, agents, working directories, skills, MCP servers, approvals, model selections, and cancellation signals remain exactly isolated;
- model-visible content enters the session log before the request, while ACP updates intended only for the UI never enter model context;
- new user-visible behavior adds unit tests, real Loader/ACP tests, cancellation and multi-session coverage, and applicable Zed compatibility validation;
- every non-trivial development run includes the repository suite and the `test:harness` official compatibility suite; the official checkout supplies current test input only and never becomes an installation or runtime dependency;
- the package profile, manifest, lockfile, README, design reference, and release documentation remain synchronized in one version update.

## Recommended Order

The active development order is `A → B → C → D`. Stage A fixes the protocol baseline and Stage B fixes the editor profile's admission, composition, and generic-projection boundaries, making both prerequisites for later work. Stage B neither blocks independent Harness capability development nor requires this repository to reproduce the complete official profile. Stage C adds per-session external-tool lifecycle and Stage D expands durable state; both follow stable isolation and ownership rules. Stage E is `Deferred`, outside the active release plan, and resumes only when demand and prerequisites mature. Additional directories proceeds in an independent DSH plugin project and is not part of this sequence.
