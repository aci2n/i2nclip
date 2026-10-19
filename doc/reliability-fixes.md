# Review reliability fixes

## Goal and scope

Recover uncertain registration in the current tab, bound transfer admission,
bound executable shutdown, and reconcile current protocol docs.
Use existing stores, HTTP responses and dependencies. No schema, encryption,
configuration, automatic retry, persistent pending enrollment or general refactor.

## Ownership and interfaces

Session owns one in-memory candidate LoadedIdentity, associated with its normalized
server origin. Existing Create retries check signed registration before spending
another invitation. A definitive unregistered result permits registration with the
current invitation; failed checks preserve the candidate without registering.
Failures retain it; successful installation, session invalidation, Reset, disposal,
or Create selecting another origin clears it. Failed Restore preserves it.
Reload/closure loses the candidate. Failure text tells users to retry in this tab.
No invitation is retained and the existing Create interface stays unchanged.

Transfer admission owns one absolute 30-second timeout across per-key and global
acquisition. Authentication, nonce consumption and size checks precede admission.
Timeout uses existing 503/Retry-After: 1 without body reads or content lookup.
Download responses use a plain stream of shared byte slices of at most 64 KiB.
The stream owns its buffer and permit until completion or disposal. There is no
application response-lifetime limit, timer, shared mutex state or forced buffer
release; stalled/unpolled responses retain their resources until disposed.
This revision removes only the download response deadline and its machinery;
admission, request-body and executable shutdown deadlines remain in scope.

The executable creates a shutdown watch channel passed to run. The server notifies
on its first signal and serving exit before awaiting maintenance/database cleanup.
The executable bounds all remaining cleanup to 30 seconds, then uses its existing
nonzero process-exit path. No lingering watchdog task. Compose allows 40 seconds.

## Acceptance and delivery

Test same-key retries after lost replies/storage failures, definitive rejection,
failed checks, changed origin, invalidation and failed Restore. Test admission at
both stages, cancellation and successful resource release. Verify responses remain
valid beyond the former 180-second limit, keep their permits until completion or
disposal, emit bounded slices and preserve bytes. Verify real API status/nonce/body
ordering and normal/stalled executable shutdown including nonzero subprocess
exit. Every fixture owns isolated mutable state and listeners bind loopback port 0.
Run client/Rust/database tests, lint/format/build checks and Firefox/Chromium suites
including large files. Commit registration, deadlines, then documentation in
cohesive warning-free changes. Update current guidance to v2 random IDs,
descriptors and authenticated chunks; preserve historical specifications.
