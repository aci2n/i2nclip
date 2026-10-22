> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# Shared unlocked sessions

Historical specification, superseded by [IndexedDB sessions](indexeddb-session.md).

## Goal, scope, and exclusions

Share unlocked access between app tabs without distributing identity-change checks
through library stores. Refactor ownership first, then add BroadcastChannel
inheritance and remove Lock. Deeplinks, server/API/database changes, wire formats,
new dependencies, cross-tab mutation locks, polling, and inactivity timers are excluded.

## Interfaces and ownership

Session owns the saved-record snapshot, wrapping key, loaded identity, record
lifetime, and local command cancellation. Persistence reads/decrypts/encrypts and
conditionally writes records without caching secrets or cancellation generations.
An immutable LibraryContext contains serverUrl, loaded key and lifetime signal.
The root owns one workspace (library, tags, uploads) for this context, disposes it
synchronously when access ends, and retains it across navigation. Settings owns
quota for that context. Consumers no longer subscribe to session changes or use
epochs; operation-specific cancellation and post-await effect guards remain.
Pairing, extension capture, preferences, and management feedback remain root-owned.

## Persistence and lifecycle

Keep the existing atomic encrypted localStorage record. Every write/removal ends
the previous record lifetime in every tab, including the writer; the writer may
install new unlocked access directly. Unlocking the same record does not end its
lifetime. Password changes cancel active work everywhere and other tabs inherit
new access automatically. Forget shares an encrypted empty identity; Reset removes
access. Failed writes preserve old access. Exact-record checks before async writes
and adoption prevent stale commits. Storage events detect record changes; channel
messages do not replace them.

BroadcastChannel uses request (random identifier, exact encrypted record text),
grant (matching identifier/text, non-extractable wrapping CryptoKey), and available
(record text). Never broadcast passwords, plaintext identity or library keys.
Recipients decrypt and validate the saved record through the password-unlock path,
recheck storage and cancellation, and accept only current requests. Donors check
storage before sharing. Advertise local unlock/commits, not inherited grants.
On startup check open tabs for 500 ms before showing password entry; late valid
grants remain acceptable until a local command or record change. Channel failure
falls back to password unlock. Access lasts in memory while unlocked tabs remain.

## Failure and cancellation cases

Commands have a separate cancellation controller: their own successful commit
ends library work but still returns success. External record changes and disposal
cancel commands. Late grants/results/progress cannot publish stale state, create
URLs, trigger downloads, or restore access. Dispose owned channels/listeners/timers.
Pending extension captures survive unlock of the same record, not replacement.
Pairing detaches from its previous lifetime before its own save and binds final
acknowledgment to the committed lifetime. Independent per-tab busy guards remain.

## Acceptance checks

Test inheritance including management operations, donor closure, all-tabs-closed
password fallback, password changes and automatic reconnection, Forget/Reset,
stale writes/grants, failed writes and channel failure. Preserve pairing save/ack,
extension pending captures, navigation-surviving uploads, per-file failures,
search/preview cancellation and URL cleanup. Tests isolate all mutable resources.
Build warning-free before cohesive commits; run make test-all with documented
prerequisites. Inspect actual Firefox screenshots of unlock/header in both themes
and narrow widths. Update current ownership docs to replace independent unlock.

Build verification must accept Vite’s already configured source maps and require
each map to have its associated generated asset; build settings remain unchanged.

## Implementation and verification

Grant replies pause during local identity commands so a record write and context
installation cannot be observed halfway through. Command completion, including
failure, announces availability so waiting tabs can request again.

Verification: `make test-all` passes 147 client tests, strict TypeScript/Svelte and
lint/format checks, web/extension artifact checks, Rust/PostgreSQL suites, and all
72 real Firefox/Chromium tests. Firefox screenshots were inspected for unlock and
header changes, mixed landscape/portrait/panorama media, audio, ordinary files,
long names, errors, both themes, and 320/360 px widths.
