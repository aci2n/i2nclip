# Client session ownership

Each web tab owns an independent session and unlocks separately. A change to the
saved identity or master password invalidates other tabs, clears their loaded
keys, and cancels pending work. Those tabs must unlock again. Local Lock affects
only its own tab. Persistence listens for identity storage changes; its listener is removed when
the session ends. Stale async writes are
rejected by comparing the current record before writing. There are no cross-tab
locks or shared unlocked keys.
The root application view owns session, library, uploads, and pairing stores
across navigation. Views subscribe and pass plain values and callbacks to
components. Components own only presentation state and have no store access.

## Identity and persistence

The session owns the decrypted identity, loaded signing/encryption/tag keys, and
cancellation generation. Its persistence helper owns the master-password wrapping
key. Locking, forgetting, replacement, resetting, and disposal invalidate work and
release key references. Session mutations reject overlap. API calls receive the
loaded crypto context rather than importing keys for every request.

One atomic base64-wrapped MessagePack localStorage record holds the encrypted identity/server and password
derivation material. Failed writes preserve the previous record and identity.
Recovery independently encrypts one identity and is validated before saving.
Recovery files use `.msgpack`; imports read bytes after checking file size.
Compression preferences are also base64-wrapped MessagePack booleans.
There are no migrations or unlock caches in sessionStorage.

Setup offers Create, Restore, and Pair device. Create and Pair use a view-local
server draft in a disclosure, defaulting to the app origin. Restore uses the
server in the recovery identity. Stores own validation, registration and saving.

## Browsing and uploads

The library owns searches, media items, and preview selection (item ID and opener).
The Library view passes the selected card directly to the dialog; its content,
loading, error, and progress state have one source of truth. Cancellation and
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
cards remain inactive until a new search replaces them. Only content loading
accepts preview cancellation; mutations use their ordinary item busy guard. Abort
checks prevent stale content/text publication, and active-load identity guards
progress and cleanup. Cancellation releases busy/progress immediately without
reporting an error or clearing a newer operation. Completed content stays cached.

Metadata updates merge name/tag patches while retaining unrelated metadata and
thumbnails. Conflicts load current metadata and leave failed editor drafts for
retry. Filename editing saves with Enter, cancels with Escape, and discards the
draft on blur without saving. Tag editing preserves failed drafts and compares
tags by protocol normalization while keeping their first spelling.

The preview dialog uses native image/audio/video elements. Navigation follows
loaded result order, skips deleted items and ordinary files, and stops at loaded
boundaries without wrapping or fetching pages. Close the preview and choose More
to load another page. Selection immediately displays the new item's cached content,
thumbnail, or filename placeholder; failures offer Retry. Navigation and close
cancel pending preview downloads, and late results cannot reopen the dialog.
The library owns one preview cancellation controller, aborted on switching, close,
search replacement, leaving Library, and session disposal. Explicit downloads
remain independently owned by media items. Navigation works during loading, and
card/dialog always share progress. Unknown progress displays “Loading…”. Players pause
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

## Upload compression

A root-owned preferences store saves the device-local compression toggle separately
from identity. It defaults on and is excluded from recovery and pairing. Upload
batches snapshot the preference. Shared upload preparation converts JPEG/PNG/BMP to
WebP at quality 0.85 before encryption, without resizing, and changes the filename
and MIME type only when output is smaller. Failed or unsupported conversions keep
the original. Existing WebP, GIF, SVG and non-images are unchanged. Original input
size is checked before decoding; bitmap resources close even on cancellation.

## Text previews

Text MIME types, JSON/XML and common text/code filename extensions open in the
media dialog as escaped read-only text. Existing image/audio/video types retain
their native viewers. The item owns its downloaded Blob and a UTF-8 preview of
at most 256 KiB, decoded only after the complete download passes hash verification
and decryption. Truncated previews are labeled; Download always saves the full
file. Disposal clears text, releases the Blob and revokes its URL.

## Search and upload controls

The Library view subscribes to root stores and passes ordinary props/callbacks
to components. The library owns a submitted tag array and a draft string. Enter
or suggestion selection adds one chip and searches; removal or Clear searches
immediately. Typing only filters the in-memory tag catalog. Pagination belongs to
the submitted array. Backspace in the empty search input removes the last chip
and searches again, retaining input focus. Session changes clear both chips and draft.

The root-owned catalog aborts superseded requests, decrypts labels, verifies their
HMAC tokens, skips damaged entries and clears decrypted state on session changes.
Mutations refresh it independently of search. Failures and retry appear beside
search. Refresh requests made during a busy session coalesce into one read when
the session becomes available. There is no polling or persistent cache. The reusable tag input owns only
suggestion visibility, keyboard navigation and DOM focus.

Upload is separate from search. Its compact summary keeps progress and failures
visible; successful filenames live in a disclosure and completion can be dismissed.
