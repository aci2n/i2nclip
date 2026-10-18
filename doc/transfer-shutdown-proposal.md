# Proposed fix: bounded transfer waiting and shutdown

Status: proposal only. The runtime changes below are not implemented. Current behavior is documented in [protocol.md](protocol.md).

## Problem and intended behavior

Downloads hold at most one 4 MiB encrypted chunk and one of sixteen shared permits until their response body completes or is dropped. A stalled response can retain both indefinitely. Upload and download admission waits are also unbounded, and graceful shutdown awaits HTTP draining, maintenance, and pool closure without an overall deadline.

Use fixed initial limits, defined beside the existing request deadlines:

| Phase | Proposed limit | On expiry |
| --- | --- | --- |
| Upload or download admission | 30 seconds | `503`, `Retry-After: 1`, no body read/content lookup |
| Download response resources | 180 seconds from response construction | Release remaining content and permit; fail further body reads |
| Process shutdown | 30 seconds from the first shutdown signal | Log unfinished shutdown and exit with a nonzero status |

Admission still queues for available capacity. Authentication and early size checks retain their current ordering; upload body-read deadlines still begin after admission. A timed-out authenticated request has spent its nonce and must retry with a fresh signature. Keep existing body limits, encryption, ownership checks, and successful response headers.

The response lifetime is absolute, not reset by chunks. Each chunk response must therefore finish within three minutes. Treat these values as initial policy choices and adjust from deployment measurements. Once headers have been sent, expiration cannot replace the response with a JSON error: terminate the body with an I/O timeout error. Content-Length makes truncation detectable, and the client's content-hash check remains mandatory.

## Download resource ownership

Replace the `unfold` stream in `src/media.rs` with a private body implementation whose content and permit live together in shared, synchronously locked state. Hold the lock only while taking a chunk or changing terminal state; never across an await. Store a terminal reason so the next body poll reports timeout consistently.

Start an independent Tokio deadline task when constructing the response. Give the task a weak reference to the resource state so it does not prolong a dropped body's lifetime. At expiry, upgrade the reference, remove the remaining bytes and permit, mark the body expired, and wake its registered body waker. This releases application resources even if the body was never polled. A timer checked only inside `poll_frame`, or a response-future timeout middleware, cannot guarantee that behavior.

The body owns the deadline task handle. Completion and body disposal cancel the task and release resources immediately. Expiry, completion, and disposal must converge on one idempotent transition. Register/check the body waker under the same synchronization used for expiry to avoid a missed wakeup.

The current zero-copy `Bytes::split_to` chunks share the original allocation. A chunk handed to Hyper could therefore keep the entire file allocation alive after the deadline clears the remaining bytes. Copy each emitted chunk into a separate buffer of at most 64 KiB, retaining the original content only in the expirable state. This adds a bounded copy per chunk and allows the original full-file allocation to be freed on expiry. Bytes already handed to the HTTP transport remain transport-owned; the deadline bounds application-held resources, not arbitrary socket or proxy buffering.

Keep database connections released before response construction. Expiration must not spawn a per-request full-file copy or retain content in the timer task. Log expiration without credentials or ciphertext.

## Admission and shutdown

Wrap each complete upload/download admission operation in `src/permits.rs` in a single 30-second timeout, covering the per-key and then global acquisition together. Reuse the existing `Error::Unavailable` response for elapsed waits or closed semaphores. Cancelling a pending acquire must leave no permit behind. Do not extend the admission timer on wakeups.

Refactor `run()` so it observes the shutdown signal once and shares that event with HTTP graceful shutdown, maintenance stopping, and an independent process watchdog. Start the watchdog on the first signal, before awaiting any drain. Normal shutdown stops accepting connections, prevents another maintenance sweep, lets active work finish, and closes PostgreSQL. Cancel the watchdog only after HTTP, maintenance, and pool cleanup have all completed.

At the 30-second deadline, the standalone executable must terminate even if a connection task or database operation remains pending. A hard process exit is the explicit final fallback; merely timing out or dropping Axum's serving future is insufficient because spawned connection tasks may survive it. Keep this process-exit policy in executable shutdown orchestration and inject its final action for unit tests. Ensure serving errors also trigger bounded cleanup.

An active upload can be interrupted by this shutdown deadline even though its body-read allowance is 120 seconds. PostgreSQL rolls back transactions that have not committed when the connection closes. A commit with a lost HTTP response remains an ambiguous outcome; preserve the existing refresh-before-retry guidance. Configure the container/service stop allowance above the application deadline, for example 40 seconds, so the application watchdog runs before the supervisor kills it.

Reverse-proxy header and idle timeouts remain useful defense in depth. Verify the deployed proxy separately; the application resource deadline must work without assuming a proxy is present.

## Required verification

- Paused-clock body tests: an unpolled response expires; a partially read response expires; trickling polls cannot extend the deadline; subsequent polls fail; normal completion and early disposal cancel the timer. Check permit release and resource-state removal in each case.
- Retain one emitted chunk while expiring the body and verify it has an independent allocation. Use the existing allocation tooling or explicit ownership instrumentation to establish full-buffer release, rather than checking permits alone.
- Real-API admission tests: occupy all sixteen download slots, expire held responses, and verify a queued request resumes. Verify queued upload/download expiry returns `503` with `Retry-After`, consumes the original nonce, and does not read an upload body or fetch download content. Preserve successful queueing, cancellation, owner isolation, and deletion tests.
- A real TCP slow-reader test with maximum-size content verifies that backpressure exercises expiration. In-process unpolled bodies alone do not establish transport behavior.
- Subprocess shutdown tests: normal shutdown exits promptly; held responses and deliberately stalled cleanup cannot prevent exit by the deadline. Cover the first signal, serving failure, and completion near the deadline; assert the watchdog is disarmed on success.
- Run `make test`, `make test-db`, `make lint`, and the Firefox suite. Profile saturation at the current four-upload/sixteen-download limits before claiming an RSS bound; The current resource profile includes sixteen held chunk responses; measurements still do not establish a hard RSS bound.

Existing storage quotas remain unchanged; total HTTP request concurrency is outside this proposal. Finite waits and response lifetimes do not establish a global memory or abuse bound.
