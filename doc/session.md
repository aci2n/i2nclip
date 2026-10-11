# Session ownership

The session service owns all identity and pending-upload storage access. UI stores
are published snapshots for rendering; they are not authoritative credentials for
an asynchronous action. Platform adapters provide raw storage only to
`session-storage.js`. An architecture regression test rejects application code
that accesses `platform.local` or `platform.session` outside that boundary.

## Storage transactions

`createSessionStorage` exposes only `transaction(callback, signal)`. It always
acquires the exclusive `i2nclip-session` Web Lock; there is no unlocked variant or
fallback. Missing Web Locks fail closed for reads and writes. The callback receives
scoped local/session capabilities. They reject access as soon as the callback
settles, before cleanup begins.
A promise continuation must be awaited within that callback to use its storage
capabilities. Late chained writes cannot append work while cleanup drains.
The mutex remains held until started storage operations settle, even if the
callback throws or forgets to await a write. The service lifetime and caller
cancellation also cover queued transactions.

The session service keeps this transaction API private. Create, restore, unlock,
server changes, reset, refresh, stale-key cleanup, and pending-upload bookkeeping
all go through it. Identity mutations read a fresh validated snapshot, perform the
change, and publish a fresh snapshot while holding the mutex. Failure refreshes
storage before reporting the error. No workflow chooses its own session lock.

Web Locks coordinate cooperating pages of the same origin. They do not provide a
transaction across browser storage areas or undo network requests.

## Identity operations

`session.operation({signal, onInvalidated})` creates a service-owned handle for
the current identity. Its expected snapshot is private; callers receive a signal,
an unlocked flag, and disposal. A handle from another service, a fabricated
handle, or a disposed handle cannot authorize an identity action.

`session.withIdentity(operation, callback)` acquires the same mutex, rereads and
validates persistent identity storage and the unlocked session key, checks the
handle, and supplies credentials to the callback. It holds the mutex through the
callback. If an authoritative read detects a missed storage notification, it also
publishes the current snapshot under the mutex before rejecting the stale handle.
This lets owners discard old work and recover with the new identity. Callbacks
must not request another session transaction or mutation;
Web Locks are not reentrant.

Pairing keeps this mutex through encrypted identity submission and its bounded
retries, then releases it before waiting for acknowledgment. Successful import
creates
a new operation handle while the save transaction is still locked. The receiver
uses that handle to authorize acknowledgment under the same mutex, so a queued
reset cannot slip between a cached save check and confirmation. Normal uploads,
listing, and media actions obtain validated credentials and release the mutex
before their longer network operations. Their operation signal and existing
request/item cancellation prevent stale results from being published. Already
submitted requests cannot be recalled by reset.

Identity mutations invalidate operation handles immediately, before waiting for
storage. They clear the published unlocked snapshot during the mutation. This
policy applies to all identity mutations by default; exporting a recovery file
explicitly uses the read-only policy. Storage notifications and resumed-page
refreshes invalidate handles in other pages after observing the change. A fresh
locked read remains authoritative when notifications are delayed or missed.

`observeIdentity` centralizes change detection for the library and pending-upload
automatic-send policy. The latter ignores unlock changes so entering a password
can still trigger its requested automatic upload. Search revisions, media-item
ownership, and pending-ID locks retain their separate purposes.

## Retained and removed mechanisms

- `identityGeneration` remains in shared local storage. Each installed identity
  gets a fresh generation, even when restoring the same key.
- `sessionGeneration` remains beside the unlocked session key. Web session storage
  is tab-local; a suspended tab can retain an old key after another tab resets and
  restores the same library. Comparing generations rejects that key without
  depending on event delivery. It also rejects incomplete or mismatched storage
  writes. A mutex alone cannot provide either guarantee.
- Local identity is saved before the unlocked session key. If the second write
  fails, the encrypted identity remains recoverable by password entry.
- `pairingRevision`, `invalidatePairing`, `withPairingIdentity`, and public
  `credentials()` snapshots are removed. General identity operations replace
  them. Pairing and uploads no longer implement their own identity comparisons.
- Pending-upload ID locks remain: they prevent two pages from sending one source.
  Session transactions protect their storage bookkeeping and reset, while the
  ID lock covers preparation and upload without holding the session mutex.
