# Structured client logging

## Goal, scope, and exclusions

Make asynchronous client flows understandable through production browser console
events. Cover application/session ownership, session sharing, pairing, routing,
extension capture and messaging, library/media, uploads, preferences, tags and
quota. No dependency, remote collection, log storage, settings, UI changes,
protocol changes, global error handlers or low-level crypto/render logging.

## Interfaces and ownership

A small web helper exposes debug/info/warn/error with a stable
`[i2nclip] scope.event` prefix and flat primitive fields. Each owner gets an
ephemeral instance identifier; repeated operations get a local sequence number.
Stores and transports log their own boundaries. Components remain presentation
only. Extension contexts use the same console convention directly; injected
functions remain self-contained and the build layout stays unchanged.

## Persistence and lifecycle

Logging stays enabled in production. The console owns output; the application
retains no logs. Instance identifiers and operation counters live only in their
owner's closure. Existing cancellation, disposal and resource ownership remain
unchanged. No new timers, listeners, asynchronous work or persisted state.

## Events, failure and cancellation

Info records major starts/outcomes; debug records intermediate steps, routine
reads, guards, cancellations and stale completions. Warn records recoverable
problems and error terminal failures. Pairing logs step transitions rather than
every poll; uploads never log progress callbacks. Partial pairing success must
distinguish saved identity from failed acknowledgment. Discovery wait expiry does
not imply the session-sharing request is canceled.

Fields are deliberately selected primitives: fixed operation/reason labels,
states, counts, elapsed time, recognized error categories and numeric HTTP status.
Never log credentials, keys, identity records, codes, tokens, payloads, filenames,
tags, URLs, media hashes, raw errors, messages or stacks. Do not spread application
objects into logs. Console failures in the web helper cannot affect workflows.

## Acceptance checks

Verify levels/format, operation correlation, sensitive-value exclusion, and
representative success, retry, cancellation, stale completion, extension pending
unlock and pairing saved-before-confirmation failure using isolated console mocks
and existing flow fixtures. Preserve bridge serialization/build tests. Run client
tests/checks, warning-free `make client` and `make test-build`. Document console
filters and the separate extension/page console locations in the client README.
