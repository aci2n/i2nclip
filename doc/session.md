# Client session ownership

The web app admits one tab per origin with a lifetime Web Lock before reading
saved state or creating application stores. Other tabs show a retry screen.
Pagehide disposes workflows before releasing admission; restored pages reacquire
admission and start fresh locked sessions.

The root application view owns session, library, uploads, and pairing stores
across navigation. Views subscribe and pass plain values and callbacks to
components. Components own only presentation state and have no store access.

## Identity and persistence

The session owns the decrypted identity, loaded signing/encryption/tag keys, and
cancellation generation. Its persistence helper owns the master-password wrapping
key. Locking, forgetting, replacement, resetting, and disposal invalidate work and
release key references. Session mutations reject overlap. API calls receive the
loaded crypto context rather than importing keys for every request.

One atomic localStorage record holds the encrypted identity/server and password
derivation material. Failed writes preserve the previous record and identity.
Recovery independently encrypts one identity and is validated before saving.
There are no migrations or unlock caches in sessionStorage.

Setup offers Create, Restore, and Pair device. Create and Pair use a view-local
server draft in a disclosure, defaulting to the app origin. Restore uses the
server in the recovery identity. Stores own validation, registration and saving.

## Browsing and uploads

The library owns searches, media items, and preview selection. Cancellation and
revision checks suppress stale results. Pagination uses the submitted query and
permits one request at a time. The separate uploads store owns sequential batches
and refreshes the submitted search after completion. Individual failures do not
stop a batch; only failure names/messages remain for manual resubmission through
Upload. Progress and completion notices are transient. Identity changes and
root disposal cancel batches and clear their state; navigation does not.

Media items own requests, cached full-content Blob URLs, previews, and mutation
busy state. Decrypted arrays are local to URL/artwork creation. Playback,
full-resolution images, and saving reuse the content URL. Disposal aborts requests
and revokes URLs; stale results cannot create previews or save dialogs. Deleted
cards remain inactive until a new search replaces them.

Metadata updates merge name/tag patches while retaining unrelated metadata and
thumbnails. Conflicts load current metadata and leave failed editor drafts for
retry. Filename editing saves with Enter, cancels with Escape, and discards the
draft on blur without saving. Tag editing preserves failed drafts and compares
tags by protocol normalization while keeping their first spelling.

The preview dialog uses native image/audio/video elements. Navigation follows
loaded result order, skips deleted items and ordinary files, and stops at loaded
boundaries without wrapping or fetching pages. Close the preview and choose More
to load another page. Loading retains the displayed media/artwork;
failures offer Retry. Closing supersedes pending display updates so late results
cannot reopen the dialog. Downloads remain owned by media items. Players pause
on navigation or close; focus returns to the opening control when available.

## Settings and pairing

Settings owns its quota store and disposes it on navigation. Reads are deduplicated,
aborted on identity changes, and protected from stale completion. Usage refreshes
on entering configured Settings, after session mutations, and after upload batches
finish while Settings is open. Errors and Retry appear beside usage; there is no
polling or persistent quota cache.

The pairing store owns one isolated attempt, relay requests, expiry, approval,
and cancellation. Both devices compare verification codes; the receiver saves
its encrypted identity before acknowledgment. Session invalidation or root
disposal ends the attempt. See [pairing](pairing.md) for protocol details.
