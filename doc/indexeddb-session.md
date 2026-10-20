# IndexedDB sessions

## Goal and scope

Consolidate persistent web-app state in IndexedDB: the password-encrypted identity,
optional remembered wrapping key, and image-compression preference. Start fresh;
do not read, migrate, or fall back to old localStorage records. Users with an old
installation reconnect through recovery or pairing. Server data is unaffected.
No protocol, recovery, pairing, Rust/database, or media-caching changes are included.
No new dependencies, polling, focus checks, or cross-tab notifications are needed.

## Interfaces and ownership

Native IndexedDB operations live behind an injected database interface. Persistence
owns encryption and conditional session transactions. The session store owns async
startup, commands, cancellation, live keys, and its database connection. Preferences
owns async loading/saving and its connection. Views subscribe and pass ordinary
props/callbacks to presentation components. Components do not access storage.
Setup/unlock accept an optional remember-device boolean, default false. Session
exposes retry and async Lock/Reset; preferences exposes loading/busy state and async save.

## Persistence and lifecycle

One database contains session and compression entries. A session entry contains a
revision, derivation parameters, encrypted identity, and optionally its matching
non-extractable wrapping CryptoKey. Never persist passwords or decrypted identities.
Identity/password/remember writes conditionally replace their expected revision in one transaction;
conflicts report an actionable refresh error and preserve the tab's existing access.
Identity updates/password changes retain the remembered choice atomically. Forget
retains the password-protected empty identity but removes remembered access; Reset
removes the current session transactionally, including malformed records. Lock also
clears the current remembered key even when invoked from an older tab. Compression is independent of these operations.

Each tab reads a consistent session once at startup. Remembered access is decrypted
and validated before publication; otherwise password entry appears. The unchecked
Remember this device option leaves access in that tab's memory only. Remove the
BroadcastChannel request/grant exchange, discovery delay, and storage-event listeners.
Ordinary operations never recheck the session. Tabs remain independent until their
own session changes, refresh, or closure. Navigation preserves root-owned work.

Lock removes remembered access transactionally and ends only the invoking tab's
session, aborting owned work. Other open tabs retain loaded access. A fresh tab or
refresh needs the password after Lock. Lock is available on all unlocked routes,
including media/setup; unlocking preserves the route. Disposal releases resources
without deleting remembered access. Close owned connections and abort transactions.

## Failures and cancellation

Startup storage failures show Retry rather than treating unavailable storage as an
empty database. Invalid remembered access reports the problem and permits password
unlock. A valid password still opens a local session if remembering fails, with
visible feedback beside the unlock controls. Failed durable mutations do not report
success or partially replace state. Lock cancels pending local commands immediately;
failure to clear remembered access reports that it remains remembered. Pending crypto,
reads and transaction completions cannot publish access after Lock/disposal. Reject
overlapping session mutations; no distributed locks. Preference saves wait for load,
retain the prior value on failure, and do not publish after disposal.

## Acceptance checks

Unit tests isolate injected mutable storage and cover opt-in, restore, validation,
password/identity changes, Forget/Reset, conflicts, storage failures, cancellation,
and cleanup. Browser tests exercise native IndexedDB in Firefox and Chromium,
refresh, independent tabs, Lock, and actual browser relaunch with an isolated
persistent profile. Verify old localStorage is ignored, new tabs require passwords
without remembering, and other tabs retain live access after Lock. Inspect Firefox
screenshots in both themes at 320/360 px. Run make test, make test-build, and
make test-e2e with documented prerequisites. Commit cohesive warning-free changes.
