# Streaming review fixes

## Goal and scope

Apply the four confirmed streaming/build fixes and two cleanup refactors from the
branch review, as six separate commits. Correct container inputs, make stream
termination idempotent, detect lost download workers, preserve loaded previews,
support the Vite development worker, and remove obsolete download progress code.

Exclusions: new dependencies, database or encryption changes, persistence,
automatic retries, whole-file buffering, and unrelated UI redesign.

## Interfaces, ownership and lifecycle

The unlocked session continues to own content streams and downloads across view
navigation. Preview leases remain view-owned. Public store methods and the server
API remain unchanged. Internal bridge messages add page ping and worker pong.
Downloads ping every ten seconds and allow thirty seconds for a reply, independent
of content reads or consumer backpressure. Failed liveness checks release the
connection, abort owned reads, reject with an actionable retry error and release
item busy state. Completion, failure, cancellation and repeated disposal settle
once and release every timer, listener and port. No workflow state is persisted.

Loading presentation resets only for source URL or type changes. Busy, message
and metadata changes retain the current loaded/error presentation. Changed URLs
still show loading and existing thumbnails while native media loads.

Vite development serves a freshly bundled classic worker at the production URL,
with JavaScript content type and no-cache. Concurrent requests share only an
in-flight build; failed builds return an error rather than application HTML.
Production output remains a disk bundle. Container inputs place its build config
next to the Vite config and copy the favicon separately.

The bounded encrypted-response reader takes a whole destination buffer and an
abort signal. Remove its unused range/progress arguments and the always-null
media preview progress field. Upload progress remains unchanged.

## Failure and cancellation

Success never sends a failure notification. Source errors, malformed reads,
consumer cancellation, session lock and invalidation use the same terminal cleanup
path. Worker loss must fail an active download within the liveness deadline and
permit a fresh user-triggered attempt. Heartbeats do not satisfy pending content
reads. Slow/paused consumers remain valid while the worker answers heartbeats.
Preview cancellation must not cancel independent downloads.

## Acceptance

Each commit builds and passes client static checks without warnings. Cover stream
completion/cancellation/disposal and heartbeat failure with isolated bridge tests;
terminate a worker during a native download and verify a fresh attempt. Verify
loaded previews survive busy-state changes and changed sources load normally.
Smoke-test Vite on loopback port zero for JavaScript delivery and registration.
Preserve chunk size/authentication and truncated/oversized response tests.
Run make test-all and the container build after refactoring; inspect Firefox
screenshots for both themes and narrow layouts. Tests own and clean up their
ports, browser contexts, databases and build artifacts on success and failure.
