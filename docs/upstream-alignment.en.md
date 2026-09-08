# Upstream Alignment, Public CI, and Zed Validation

[中文](upstream-alignment.md) | English

This reference defines the product direction and quality-improvement order for `dsh-acp-interactive` after `1.0.3`. The project does not aim to match the feature count of other community ACP implementations. It prioritizes alignment with the published DeepSeek Harness architecture, an auditable standalone distribution, public continuous verification, and evidence from real Zed usage.

See the [Upstream-Aligned Product Direction Agent Note](agent-notes/2026-09-08-upstream-aligned-product-direction.md) for the architectural decision. The [design](design.md), [development roadmap](roadmap.en.md), and [Zed compatibility matrix](compatibility.en.md) remain authoritative for individual protocol capabilities.

## Product Principles

### 1. Preserve Upstream Domain Ownership

Published Harness plugins remain the only implementations of existing model invocation, agent-loop, tool execution, credential, permission, sandbox, skill, persistence, session-query, compaction, and lifecycle behavior. This repository composes and consumes those plugins instead of copying their domain implementations into the ACP transport.

The ACP layer owns editor protocol adaptation, capability negotiation, event projection, connection output ordering, and the binding between ACP requests and exact Harness session/agent lifecycles.

### 2. Prefer Composition to Reimplementation

A new capability first requires a stable, published Harness Service Definition, Provider, Consumer, and lifecycle policy. A complete closure may enter the editor profile after explicit review. Without that closure, the capability remains unadvertised, fails explicitly, or stays deferred rather than creating a parallel domain implementation merely to fill a feature table.

`config/cordis.yml`, `config/editor-profile.json`, `package.json`, and the lockfile jointly define the released composition. Every bare plugin is a direct runtime dependency. Profile reconciliation reports drift but never changes user behavior without review.

### 3. Advertise Only Complete Capability Closures

An optional ACP capability may be advertised only when all of the following are true:

1. its Harness services are fully composed;
2. the client declares the required stable ACP capability or an explicitly reviewed compatibility field;
3. the path passes through the packaged, real launcher;
4. exact session, connection, agent, cwd, skill, approval, model, MCP, and cancellation isolation is preserved;
5. cancellation, failure, restore, and teardown semantics are deterministic.

Composing an internal Harness policy does not automatically make it an ACP capability. ACP projects only visible results and explicit failures.

### 4. Prefer Correctness and Upstream Compatibility to Feature Count

Session fork, LSP, unsaved-buffer access, embedded context, compaction UI, and features already present in another community implementation do not enter this roadmap automatically. They are considered only when:

- Zed/ACP has a concrete demand and a stable protocol surface;
- Harness publishes a reusable domain closure;
- the editor profile can preserve standalone installation, capability negotiation, and lifecycle isolation;
- maintenance does not force the ACP transport to take over upstream domain behavior.

Release quality is not measured by feature, method, or comparison-table parity with another agent.

### 5. Keep the Installed Artifact Standalone

The npm package must install, launch, and complete core ACP flows in a clean directory without a DeepSeek Harness source checkout. An official checkout is only a fixture for compatibility tests, profile reconciliation, and candidate-capability review. It is never an install, launch, or runtime dependency.

### 6. Separate Model Context from UI Projection

Model-visible content enters the durable Harness session log before request assembly. ACP messages, thoughts, tool cards, diffs, terminals, plans, titles, usage, and catalog updates intended only for Zed UI never enter model context or alter Harness permission and filesystem boundaries.

### 7. Grade Evidence and Do Not Present Inference as Observation

Documentation distinguishes:

- schema/type-level protocol compatibility;
- automated contracts using simulated Zed capabilities;
- ACP tests against the real packaged launcher;
- manual acceptance in real Zed Stable/Preview UI.

Only the last level may be labeled “verified in real Zed.” Conclusions derived from Zed source, release notes, or the SDK remain explicitly labeled as contract evidence or compatibility inference.

### 8. Apply Minimal, Auditable Provenance and License Handling

Original project work remains MIT-licensed. Deletion of a historical upstream file is not the sole criterion for determining the provenance of retained code. The project audits code that remains derived from historical sources and preserves only the copyright and license notices applicable to that retained material. A local third-party notice does not relicense the whole project or restore unrelated historical licensing structure.

## Continuous Verification Model

### Release Artifact Verification: Blocks Merge and Release

This lane uses only this repository and public npm packages installed from its lockfile. Supported platforms must pass:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm pack --dry-run`
5. `npm run verify:packed`
6. clean installation from the packed tarball
7. a real-launcher `initialize → session/new → session/prompt → session/cancel/close` ACP smoke flow
8. Registry stable/legacy terminal-auth initialize probes
9. `git diff --check`

This lane proves that the artifact users receive runs independently. A sibling checkout, workspace link, or unpackaged file may not complete its dependency closure.

### Pinned Upstream Compatibility: Blocks Release

The repository records one known-compatible official DeepSeek Harness tag or commit. CI uses that fixed revision for available official compatibility tests and editor-profile reconciliation. Updating the pinned baseline requires an explicit PR that describes:

- official package and service changes;
- candidate capabilities added, removed, selected, or still deferred;
- breaking protocol or lifecycle changes;
- synchronization of package, profile, and lockfile.

If the official revision no longer contains a historical test path, tooling reports `fixture unavailable` explicitly. Missing tests are neither treated as success nor repaired by modifying the official checkout.

### Upstream-Tip Observation: Scheduled, Visible, Initially Non-Blocking

A scheduled and manually dispatchable workflow runs profile drift, type, or compatibility observations against the default DeepSeek Harness branch. It detects upstream changes early but never upgrades dependencies or changes the released composition automatically.

This lane may initially be non-blocking, but failures remain visible in Actions and become trackable work. Before an upstream revision enters the supported range, it becomes the pinned baseline and passes the complete release lane.

## Public CI Improvements

### Required CI

GitHub Actions uses this matrix:

| Platform | Node |
| --- | --- |
| Ubuntu | minimum supported `22.19.x`, current `24.x` |
| macOS | minimum supported `22.19.x`, current `24.x` |
| Windows | minimum supported `22.19.x`, current `24.x` |

Every matrix leg runs at least `npm ci`, typecheck, repository tests, build, pack dry-run, and packed-install verification. Real platform shell, stdout purity, and cancellation tests are not silently skipped for runner convenience. Missing platform prerequisites either fail explicitly or move to a dedicated job with the complete prerequisites.

### Independent Quality Jobs

- `registry-auth`: verify terminal auth with the Registry initialize payload;
- `launcher-smoke`: install the tarball and run a core ACP session;
- `upstream-pinned`: verify the fixed Harness baseline;
- `upstream-latest`: observe the official default branch on a schedule;
- `package-audit`: reconcile Cordis bare plugins, runtime dependencies, packlist, and versions;
- `release`: run only for explicit version tags, create a GitHub Release, and use npm trusted publishing/provenance; ordinary CI holds no publishing token.

README badges report npm version, CI, and license status only to the extent the referenced workflows actually verify them.

## Real Zed Validation

### Automated Contract Layer

Maintain a versioned `clientCapabilities` fixture from supported Zed source or a captured handshake. The real packaged launcher verifies at least:

- conditional terminal-auth advertisement;
- prompt modality, MCP, and session-lifecycle capabilities;
- message IDs and request cancellation;
- model, reasoning, and permission configuration;
- form elicitation;
- terminal presentation fallback;
- suppression, rejection, or non-use when a client omits a capability.

The fixture records its Zed version and commit. Capability differences are reviewed whenever it changes.

### Stable/Preview Manual Acceptance Layer

Every behavior release that claims Zed compatibility completes a real installation check in Zed Stable on at least one supported operating system. Releases that change capability negotiation, terminal authentication, or new ACP fields also verify Zed Preview.

The checklist includes:

1. launch from a packed/npm artifact rather than the source directory;
2. `initialize` and first-use `--setup` Terminal Auth;
3. a new session with streamed messages and reasoning;
4. shell terminal cards and file diffs;
5. permission allow/reject;
6. model and permission selectors;
7. list/load/resume after session close;
8. cancelling one session without affecting another;
9. MCP startup, invocation, cancellation, and teardown when the release affects MCP;
10. stdout containing only ACP JSON-RPC frames.

A versioned report records Zed, operating system, Node, npm package version, every result, and necessary redacted evidence. Failures and untested items remain visible instead of being replaced by protocol inference.

## Improvement Steps and Acceptance Gates

### Q0: Provenance Audit and Notice Boundary

- compare retained implementation with historical upstream sources;
- classify original, modified, and still-recognizable derived material;
- add only notices required for retained material;
- keep original project work under MIT.

Acceptance: file and history evidence can reproduce the decision, the package contains applicable notices, and “upstream deleted it” is not the sole test.

### Q1: Public Cross-Platform CI

- establish the Ubuntu/macOS/Windows and Node 22.19/24 matrix;
- add Registry auth, packed launcher, package closure, and stdout guard jobs;
- make required checks branch merge gates;
- show the real CI state in README.

Acceptance: contributors and Registry maintainers can inspect complete supported-platform results without access to a development machine.

### Q2: Upstream Compatibility Pipeline

- record a fixed Harness tag/commit;
- run `check:profile` and available `test:harness` inputs against that baseline;
- add scheduled upstream-tip observation;
- distinguish fixture absence, profile drift, and real failures.

Acceptance: supported-upstream and latest-upstream status cannot be confused, and every baseline upgrade enters a release through explicit review.

### Q3: Real Zed Validation

- maintain a versioned Zed capabilities fixture;
- add contract tests;
- run the Stable/Preview manual smoke checklist;
- retain redacted reports, screenshots, or a short video.

Acceptance: the Registry PR and README can link to reproducible real-Zed evidence rather than release-note inference alone.

### Q4: Release and Registry Evidence

- create formal GitHub Releases;
- establish an auditable publishing path without a long-lived npm token;
- link public CI, the upstream baseline, and Zed reports from the Registry PR;
- describe the project as composition-first and upstream-aligned rather than feature-maximal.

Acceptance: a Registry reviewer can verify package provenance, tests, upstream relationship, authentication, and real Zed behavior through public links.

## Current Non-Goals

- copy session fork, LSP, unsaved-buffer access, or compaction UI merely to match another community implementation;
- make a DeepSeek Harness source checkout an end-user prerequisite;
- patch Harness domain-service gaps inside the ACP transport;
- claim DeepSeek or Zed endorsement;
- describe automated contract tests as real Zed UI acceptance;
- automate publishing through a long-lived personal npm token.

## Current Priority

Before active feature work resumes, quality work proceeds as `Q0 → Q1 → Q2 → Q3 → Q4`. Q0 defines provenance and notice boundaries only for retained material; Q1 makes evidence public; Q2 pins and observes upstream; Q3 verifies the real client; Q4 assembles release and Registry evidence. Feature breadth does not interrupt this order except for correctness, security, or upstream-compatibility fixes.
