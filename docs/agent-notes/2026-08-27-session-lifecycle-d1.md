# Session Lifecycle D1

Release `0.8.1` completes Stage D1 by strengthening the already-supported session lifecycle without inventing deletion, metadata pagination, or fork behavior. It covers concurrent `session/list`, `session/load`, `session/resume`, and `session/close`, plus recovery through two real launcher processes that share only the JSONL source of truth. Each process retains its own in-memory SQLite session-query index.

## Close durability boundary

An ACP client reasonably treats a successful `session/close` response as the point at which a different editor process may discover and restore the durable history. Waiting only for prompt work, outbound ACP updates, continuable descendants, and `AgentHandle.dispose()` did not establish that guarantee: Harness persistence observes session disposal asynchronously, so an immediate cross-process list could race the JSONL retirement flush.

The bridge now invokes the owning Harness `ctx.sessions.flush(session)` checkpoint after all agent work is idle and before disposing the handle. This uses the backend-independent session durability seam; the transport never opens, edits, or coordinates JSONL or SQLite artifacts itself. The direct service access makes `sessions` an explicit required injection.

The checkpoint and live-resource teardown have separate failure responsibilities. If the checkpoint rejects, the bridge still disposes the session MCP host and exact `AgentHandle`, then rejects close with the checkpoint failure. It never leaves an untracked live agent merely because durability could not be confirmed. A successful response therefore means both durability and online teardown completed; a failed response means no live ownership remains, but the caller must not assume the latest history became durable.

## Concurrency and process isolation

Within one connection, a restore reserves its session id before the first asynchronous read. A simultaneous load or resume of that same id fails as already active, while restores of different ids, list observations, and closes proceed independently. Concurrent closes share the same teardown promise.

The real launcher test starts two processes before the source session is created. The writer commits a plan-mode event and closes; the reader then lists, loads, closes, resumes, and closes the same id. Repeated list calls prove that close remains non-destructive. Discovery comes from the shared JSONL source; no SQLite derived-index file or connection is shared.

## Deferred Stage D surface

`session/delete`, attachment/checkpoint/index reconciliation, stable metadata cursors, authoritative low-cost `updatedAt`, and ACP fork remain deferred. D1 changes no advertised ACP capabilities and is not completion of Stage D.
