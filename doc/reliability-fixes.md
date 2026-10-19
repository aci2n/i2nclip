# Review reliability fixes

## Goal and scope

Recover uncertain registration in the current tab, bound transfer admission and
response lifetimes, bound executable shutdown, and reconcile current protocol docs.
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
A private download stream owns bytes and permits through completion, disposal or
an independent absolute 180-second deadline, including bodies never polled.
Emitted chunks own independent allocations of at most 64 KiB. Expiry releases
resources and the next poll fails once, then ends. Completion/Drop stops its timer.

The executable creates a shutdown watch channel passed to run. The server notifies
on its first signal and serving exit before awaiting maintenance/database cleanup.
The executable bounds all remaining cleanup to 30 seconds, then uses its existing
nonzero process-exit path. No lingering watchdog task. Compose allows 40 seconds.

## Acceptance and delivery

Test same-key retries after lost replies/storage failures, definitive rejection,
failed checks, changed origin, invalidation and failed Restore. Test admission at
both stages, absolute response expiry without polling, partial/trickling reads,
independent output allocations, cancellation and successful resource release.
Verify real API status/nonce/body ordering and queued capacity recovery, real TCP
backpressure, and normal/stalled executable shutdown including nonzero subprocess
exit. Every fixture owns isolated mutable state and listeners bind loopback port 0.
Run client/Rust/database tests, lint/format/build checks and Firefox/Chromium suites
including large files. Commit registration, deadlines, then documentation in
cohesive warning-free changes. Update current guidance to v2 random IDs,
descriptors and authenticated chunks; preserve historical specifications.
