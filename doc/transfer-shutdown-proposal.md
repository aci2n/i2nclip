# Transfer and shutdown deadlines

Status: implemented. See [protocol](protocol.md) for the complete current API and
[review fixes specification](reliability-fixes.md) for scope and acceptance checks.

| Phase | Absolute limit | On expiry |
| --- | --- | --- |
| Upload/download admission | 30 seconds across per-key and global acquisition | Existing `503`, `Retry-After: 1`; no body read/content lookup |
| Download response resources | 180 seconds from response construction | Release original bytes/permit; fail subsequent body reads |
| Executable shutdown | 30 seconds after signal or serving exit | Report timeout and exit nonzero |

Authentication, nonce consumption and early size checks precede admission. Body
read deadlines start after admission. A timed-out authenticated request must retry
with a fresh signature and nonce. There are no new settings or dependencies.

## Download ownership

A private stream adapter keeps bytes and its transfer permit in one synchronously
locked state. An independent Tokio timer holds only a weak reference and expires
resources even if the body is never polled. Completion and Drop cancel the timer;
expiry, completion and disposal release the resources. The next poll after expiry
returns an I/O timeout and then ends. The stream never returns Pending, so it needs
no stored body waker. Polling also checks the absolute deadline independently of
when the timer task runs. Trickling data does not extend the allowance.

Each emitted slice copies at most 64 KiB into an independent allocation. Retaining
an emitted slice cannot retain the original 4 MiB + tag buffer after expiry. Bytes
already passed to Hyper or socket buffers remain transport-owned. Connections are
released before constructing responses. This does not establish a hard RSS bound.

Once headers have been sent, expiry cannot replace the response status. The body
fails; Content-Length detects truncation, and clients validate chunk lengths and
GCM authentication before exposing plaintext. There is no complete-file hash check.

## Shutdown ownership

The executable supplies the server's shutdown watch channel. The first signal
notifies HTTP draining, maintenance and the executable's deadline; serving exit
also notifies before awaiting cleanup. The executable awaits the remaining server,
maintenance and pool work within 30 seconds. Timeout reaches main's existing error
and nonzero process-exit path, terminating detached tasks too. Normal completion
leaves no background watchdog task.

Compose gives the server 40 seconds before supervisor termination. Other deployment
supervisors should likewise allow more than 30 seconds. Shutdown may interrupt an
upload despite its 120-second read allowance. Uncommitted database transactions
roll back; a commit followed by a lost reply remains ambiguous. Reverse-proxy
header/idle timeouts remain deployment concerns; application expiry works without
assuming a proxy. Storage quotas and overall HTTP concurrency policy are unchanged.

## Verification

Paused-clock tests cover both admission stages, absolute response expiry, unpolled
and partially read bodies, independent emitted buffers, completion and disposal.
Real API tests verify timeout status/header, nonce consumption, unread queued
bodies and queued reads resuming after expiry. A loopback port-0 TCP test uses
bounded socket buffers to exercise actual slow-reader backpressure. Shutdown tests
cover notification timing, cleanup and serving errors; a subprocess verifies the
nonzero exit path with a detached task that would prevent runtime teardown.
