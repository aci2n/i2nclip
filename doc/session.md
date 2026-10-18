# Client session ownership

Tabs share unlocked access through an in-memory BroadcastChannel. A tab requests
access for its exact encrypted saved record; an unlocked tab supplies the
non-extractable wrapping CryptoKey. The recipient decrypts and validates its own
saved record, rechecks storage, then installs access through the same path as
password unlock. No password or plaintext identity is broadcast or newly persisted.
Recipients can become donors. Closing all app tabs ends live access. There is no
Lock action, timer, polling, leader election, or cross-tab mutation lock.

Session owns one saved-record lifetime and a separate local command lifetime.
Storage events invalidate old access on password/identity changes and Reset.
Every committed record change ends old work in the writer too. The writer installs
new access and announces availability; other tabs can reconnect automatically.
Late grants cannot restore old access. A missing or failed channel uses password
unlock. See [shared-session specification](shared-session.md).

The root application owns a workspace for the fixed LibraryContext (server URL,
loaded key and lifetime signal). It contains library, tags and uploads stores,
survives page navigation, and is synchronously disposed when its context ends.
These stores never subscribe to session changes or compare epochs. Settings owns
quota for the fixed context. Root-owned pairing and extension capture use the
record lifetime; pending captures survive unlocking the same record, not replacement.
Views subscribe to stores and pass ordinary props and callbacks to components.

The application store creates and disposes the root resources and coordinates
workspace creation and file uploads from drops or extension handoff. Application
is the root view: it renders state and translates drag events into store calls. Native anchors navigate through hash
URLs; the routing store owns history updates and its hashchange listener. Ordinary navigation pushes history; accepted drops and captures replace
the current entry with Library. Pure route parsing and link formatting live outside stores in lib/routes.ts;
views and components use these helpers without importing routing state.

## Identity and persistence

Session privately owns the wrapping key, decrypted identity and loaded keys.
Persistence has no secret cache or cancellation generation: it reads, decrypts,
encrypts and conditionally writes snapshots under the caller's signal. Commands
reject overlap. Their own successful commit ends the old workspace without
canceling their success result; external changes and disposal cancel commands.
Async work still checks cancellation before publication or resource creation.

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
loading, error, and progress state have one source of truth. Session and request cancellation suppress stale results. Pagination uses the submitted query and
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

## Direct media links

Fresh `#/media/<content hash>` tabs reuse session sharing but do not create
the browsing workspace or request lists/tags. A viewer store reads one encrypted
metadata summary, owns one media-item store, and releases it on navigation or
context changes. Explicit downloads reuse its verified/decrypted content. Native
players start on user action. Text remains escaped and bounded; other files offer
Download. The app URL stays stable. Setup can complete inline without losing the
target. Navigating to Library lazily creates the workspace, which then retains its
ordinary root-owned lifetime. See [deeplinks](deeplinks.md).

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
search. The catalog starts loading when its workspace is created; refreshes supersede
older reads. Session commands do not pause reads; committing a changed record
disposes the old catalog. There is no polling or persistent cache. The reusable tag input owns only
suggestion visibility, keyboard navigation and DOM focus.

Upload is separate from search. Its compact summary keeps progress and failures
visible; successful filenames live in a disclosure and completion can be dismissed.
