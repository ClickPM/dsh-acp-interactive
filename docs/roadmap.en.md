# dsh-acp-interactive Development Roadmap

[中文](roadmap.md) | English

This reference defines the recommended development order for `dsh-acp-interactive` after the self-contained Zed integration. ACP owns editor-agent communication fields and lifecycle methods; this plugin owns protocol adaptation and Cordis composition; DeepSeek Harness continues to own model, tool, skill, permission, persistence, and agent-loop behavior.

## Current Baseline

Version `0.5.3` ships a standalone `dsh-acp-interactive` command, a package-owned Cordis profile, and one mutually exclusive native shell per platform. Users can access text and reasoning streams, tool cards, diffs, approvals, plans, model and reasoning-effort selection, permission presets, images, resource links, structured questions, persistent sessions, official human slash commands, and user-invocable skills in Zed without downloading or modifying the DeepSeek Harness source.

Production uses ACP v1. ACP v2 remains a Draft and is not the near-term default. The plugin advertises an optional protocol capability only when the client declares support and the assembled Harness services implement it completely.

## Stage A: Align with the Latest Stable ACP v1

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

## Stage B: Align with the Complete Official Harness Profile

### Objective

Bring the standalone launcher's Harness capability set close to the complete official profile without moving domain behavior into the transport.

### Deliverables

- Treat the official bundle/profile composition and actual plugin source as authoritative, with automated reconciliation instead of a drifting handwritten plugin or command list;
- compose web search/fetch, enhanced file search, LSP, persistent terminals, subagents, workflows, spill, tool-result pruning, timeout policy, and loop guards;
- expose only human commands whose plugins actually call `ctx.commands.register()`, never model-only tools;
- compose each command with its domain service, provider, and lifecycle policy;
- add package dependency closure, Cordis Loader, runtime closure, and official-profile difference checks.

### Acceptance

- A clean installation loads the complete composition outside a Harness checkout;
- reconciliation reports official-profile additions or removals of human commands, required providers, and critical consumers;
- real ACP flows execute at least one newly added human command, tool, subagent, and workflow path;
- multiple sessions, connections, and Zed processes do not share derived state or cancellation signals.

## Stage C: Additional Directories and MCP

### Objective

Implement ACP's stable additional workspace roots and accept MCP server configuration supplied by Zed.

### Deliverables

- Validate and pass `additionalDirectories` through `session/new`, `session/load`, and `session/resume`;
- map additional roots into Harness filesystem, sandbox, and observation policies without changing the primary `cwd` semantics for relative paths;
- own an independent MCP server lifecycle, tool registration, and teardown for each session;
- apply the same agent-scope checks to commands, skills, MCP tools, file access, and approvals;
- define failures for unsupported MCP transports, startup failure, cancellation, and configuration changes during resume.

### Acceptance

- Primary and additional root access follows read-only, workspace-write, and danger-full-access policy;
- one session's MCP tools, roots, and failures never enter another session;
- load and resume use the complete roots and MCP configuration from the request without inheriting another connection's live state.

## Stage D: Complete Session Management

### Objective

Complete discovery and deletion for large session histories while preserving derived-index consistency.

### Deliverables

- Add a backend-independent delete operation to the Harness persistence capability before implementing ACP `session/delete`;
- add stable opaque cursors, pagination, and authoritative `updatedAt` values to `session/list`;
- reconcile deletion across the JSONL source of truth, attachments, checkpoints, and session-query derived indexes;
- project Harness session forks after ACP session fork stabilizes and Zed supports it;
- add concurrent list/load/resume/close/delete tests and multi-process recovery coverage.

### Acceptance

- The ACP transport never implements deletion by editing JSONL files or private SQLite tables;
- cursors remain deterministic when sessions are added or updated during pagination, without silent duplicates or omissions;
- close releases live resources and delete removes durable history; the two operations retain separate semantics.

## Stage E: Rich Content and Real-Time UI

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

## Stage F: Distribution, Authentication, Remote Transport, and ACP v2

### Objective

Move from developer installation to a discoverable and diagnosable distribution while establishing a controlled path to remote deployments and the next protocol generation.

### Deliverables

- Publish ACP Registry metadata and standard installation configuration;
- implement ACP authentication state, login, and logout separately from model-provider credentials;
- expose version, configuration-source, provider-loading, and capability-negotiation diagnostics without writing secrets to stdout or logs;
- evaluate HTTP and WebSocket deployments after the remote transport stabilizes, including connection-level identity isolation;
- ship ACP v2 only as an explicit compatibility preview until both v1 and v2 protocol tests support a default migration decision.

### Acceptance

- Users can install and start the plugin from the Registry without entering a source path;
- agent-service authentication, model API credentials, and Zed session identities remain separate;
- a remote connection cannot list, resume, or operate another identity's sessions;
- ACP v2 Draft changes cannot break stable v1 users.

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

Implement `A → B → C → D → E → F`. Stage A fixes the protocol baseline and Stage B completes the Harness capability set, making both prerequisites for later work. Stages C and D expand resource scope and durable state after isolation and ownership rules are established. Stage E improves presentation. Stage F handles distribution and the next protocol generation without forcing production users onto Draft capabilities.
