# Remove redundant application guards

Historical specification. Session lifetime and unlock behavior are superseded by
[shared sessions](shared-session.md); current ownership is described in [session](session.md).

## Goal and scope

Audit the web app and extension for checks that repeat caller or lifetime
guarantees. Keep callers small and use session cancellation as the authority for
identity invalidation. This follows the session/persistence simplification.
No protocol, schema, persistence-format, UI, dependency or product changes.

## Ownership and interfaces

Session owns identity changes, the session abort signal and operation invalidation.
Stores use that signal, composed with cancellation for their own resources. Remove
parallel revision/epoch/disposed checks when an aborted signal already implies
all of them. Retain epoch subscriptions where they reset visible state or discard
pending captures; those are notifications, not a second validity mechanism.
Keep ordinary store busy guards and genuine readiness checks. Internal functions
may rely on the guarantees of their callers and detached listeners.

## Async boundaries and resources

Aborting fetch is insufficient for non-abortable work (crypto, Blob reads, image
decoding) and injected requests that finish late. Keep one validity check before
publishing or causing a side effect after such awaits. Local search replacement,
preview cancellation, disposal, upload-file completion, and pairing expiry retain
their own cancellation because their lifetimes differ from the session. Do not
move presentation/resource ownership into the session or add a generic job engine.

Remove duplicate synchronous checks already enforced by a containing function or
adjacent check with no await between them. Keep completion handlers suppressed
after receiver disposal. External input validation, content size limits, hashes,
signatures and pairing-step checks remain protocol boundaries, not defensive
application-state checks.

## Failures and acceptance

Late success/failure/progress cannot overwrite newer work. A failed upload still
allows remaining files. Canceled previews create no URLs or save dialogs; item
resources are revoked exactly once. Search supersession and pagination behavior,
tag refresh coalescing, pending extension captures, and durable pairing save/ack
behavior remain. Use existing isolated lifecycle tests and add behavior coverage
only where an uncovered invariant warrants it. Run strict checks, client/Rust
tests, web/extension builds and real Firefox/Chromium tests. Commit cohesive,
verified changes and document the reasons for retained guards.

## Audit result

- Search replacement, identity invalidation and disposal already abort a search's
  composed signal. Remove its second revision counter and repeated disposed tests.
- Upload batches use the session/lifetime signal; remove their revision counter
  and separate disposed flag. Retain the per-file finished flag because a completed
  upload need not have an aborted signal.
- Quota and tag results check their captured signal, not a second epoch/disposed
  predicate. Epoch notifications only clear their visible state. Session owns
  identity cancellation; local controllers still handle supersession or disposal.
- Media uses its lifetime signal instead of checking both epoch and disposed.
  Retain active-load identity for progress and release: a finished load's signal
  can remain active while a newer operation starts. Retain checks after content
  downloads and Blob reads before creating URLs, publishing text or saving.
- Extension upload admission happens in validated receipt and pending-delivery
  callers, so the private upload function has no entry guards. Detached listeners
  need no disposed entry checks. Async completion still
  suppresses replies after disposal and classifies identity cancellation.
- Pairing checks retry boundaries in one helper. The store trusts the locally
  generated verification code and the relay's validated capability. Remove the
  obsolete malformed-worker-output test; direct protocol/crypto tests still verify
  code format, all derived bits, authentication and matched codes. Peer messages,
  room ownership, step ordering, expiry, approval and save/ack checks remain.
- Remove null checks after successful document validation, duplicate submit guards,
  and duplicate canvas branches. Canvas test doubles expose the real context.canvas
  contract rather than requiring a runtime fallback.

The remaining async guards protect actual effects and resources. Session code
cannot cancel Blob reads or crypto already in flight, and request cancellation
alone cannot suppress a successful result returned by a non-abortable dependency.
No additional task framework or parallel validity state was introduced.

Verification: make test passes client checks with zero errors/warnings and all
client/Rust tests; make test-build passes web and unpacked-extension checks. All
64 Firefox/Chromium integration tests pass. The final receiver admission cleanup
also passes the extension handoff integration test in both browsers (2 checks).

## Readiness ownership follow-up

Replace the standalone libraryReady(snapshot) predicate with a readonly
session.ready getter. Session owns the derived value: unlocked, configured,
not busy and not disposed. Add no mutable state or persistence. Update all stores,
application event handlers and test doubles to consume the session contract.
Keep cancellation, local busy guards and lifecycle behavior unchanged. Remove the
old export. Verify readiness during registration, lock/unlock, forget and disposal,
run client checks/tests and web/extension builds, and exercise library uploads and
drag/drop in Firefox and Chromium. No protocol, schema or UI changes.
