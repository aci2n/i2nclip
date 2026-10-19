# Transfer and shutdown deadlines

Status: implemented. See [protocol](protocol.md) for the complete current API and
[review fixes specification](reliability-fixes.md) for scope and acceptance checks.

| Phase | Absolute limit | On expiry |
| --- | --- | --- |
| Upload/download admission | 30 seconds across per-key and global acquisition | Existing `503`, `Retry-After: 1`; no body read/content lookup |
| Executable shutdown | 30 seconds after signal or serving exit | Report timeout and exit nonzero |

Authentication, nonce consumption and early size checks precede admission. Body
read deadlines start after admission. A timed-out authenticated request must retry
with a fresh signature and nonce. There are no new settings or dependencies.

## Download ownership

Download responses use a plain stream, owning one encrypted chunk and its download
permit until completion or disposal. Each emitted slice shares the original
allocation and is at most 64 KiB. Database connections are released before response
construction. There is no application response-lifetime limit or independent
expiry timer; a stalled or unpolled response retains its resources until disposed.
Clients still validate exact chunk lengths and GCM authentication before exposing
plaintext. There is no complete-file hash check.

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
header/idle timeouts remain deployment concerns. Storage quotas and overall HTTP concurrency policy are unchanged.

## Verification

Paused-clock tests cover both admission stages and verify download responses remain
valid past the former response deadline. Body tests verify bounded slices, byte
preservation and permit release on completion/disposal. Real API tests verify
admission timeout status/header, nonce consumption and unread queued upload bodies.
Shutdown tests cover notification timing, cleanup and serving errors; a subprocess
verifies the nonzero exit path with a detached task that would prevent runtime
teardown.
