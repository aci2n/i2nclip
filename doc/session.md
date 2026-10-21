> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Client session ownership

## Construction and initial reads

Store factories return private classes with private state and grouped, bound public
commands. Constructors perform cheap synchronous setup, including listeners and
thumbnail URLs; they do not start network or storage reads. Application.start()
installs coordination and launches Session.load()/Preferences.load(). Workspace.start()
launches quota.refresh(), tags.refresh() and library.search(). Both start methods
are idempotent and cannot restart disposed instances. Media views explicitly call
viewer.retry() after construction. Session/Preferences load() returns the cached
initial completion promise; Session.retry() explicitly retries a failed read.
Session.initialize(password, rememberDevice) still configures the master password.

Each tab loads its saved session once from IndexedDB at startup. A remembered
non-extractable wrapping key decrypts and validates the encrypted identity; without
one, the tab requires the master password. Remember this device is optional and
initially unchecked. Unremembered access exists only in that tab's memory.
There is no session-sharing channel, polling, storage listener, or focus check.

Lock clears remembered access and cancels work only in the invoking tab. Other
open tabs retain their loaded access until refresh or closure. Password/identity
changes and Reset also leave other tabs' live work alone. Their later session
writes are conditional transactions and reject stale snapshots with a refresh
message. Navigation preserves the local session; disposal ends work and closes
owned database connections without clearing remembered access. See the
[IndexedDB session specification](indexeddb-session.md).

The root application owns a workspace for the fixed LibraryContext (server URL,
loaded key and lifetime signal). It contains library, tags, quota and uploads stores,
survives page navigation, and is synchronously disposed when its context ends.
These stores never subscribe to session changes or compare epochs. Settings receives
quota and uploads explicitly from the application. Root-owned pairing and extension capture use the
record lifetime; pending captures survive unlocking the same record, not replacement.
Views subscribe to stores and pass ordinary props and callbacks to components.

The application store creates and disposes the root resources and coordinates
workspace creation and file uploads from drops or extension handoff. Application
is the root view: it renders state and translates drag events into store calls.
Native anchors navigate through hash URLs; the routing store owns history updates
and its hashchange listener. Ordinary navigation pushes history; accepted drops
and captures replace the current entry with Library. Pure route parsing and link
formatting live outside stores in lib/routes.ts; views and components use these
helpers without importing routing state. Its ordered definitions own matching,
parameters, canonical URLs and workspace requirements. Route types are derived
from the definitions. Resolved routes carry a workspace flag that permits creating
a missing workspace; navigation never disposes an existing workspace.

## Identity and persistence

Session privately owns the wrapping key, decrypted identity and loaded keys.
Persistence has no secret cache or cancellation generation: it reads, decrypts,
encrypts and conditionally writes snapshots under the caller's signal. Commands
reject overlap. Identity/password commits end the old workspace without canceling
their success result. Remembering access during unlock preserves pending work for
the same saved record; local Lock and disposal cancel commands.
Async work still checks cancellation before publication or resource creation.

One transactional IndexedDB session record holds the encrypted identity/server,
password derivation material, revision, and optional remembered wrapping key. Failed writes preserve the previous record and identity.
Recovery independently encrypts one identity and is validated before saving.
Recovery files use `.msgpack`; imports read bytes after checking file size.
Compression is a separate IndexedDB boolean. Old localStorage records are not
read or migrated: existing installations reconnect through recovery or pairing.
Passwords and plaintext identities are never persisted.

Setup offers Create, Restore, and Pair device. Create and Pair use a view-local
server draft in a disclosure, defaulting to the app origin. Restore uses the
server in the recovery identity. Stores own validation, registration and saving.
Create retains one candidate identity in session memory before sending registration.
Retrying Create for the same normalized server origin checks its signed registration
first: a registered candidate is saved without spending another invitation; a
definitively unregistered candidate uses the currently submitted invitation. Failed
checks do not submit registration. Registration/storage failures and failed Restore
attempts retain the candidate. Successful installation, local session replacement,
Lock, Reset, disposal, or Create selecting another origin clears it. No invitation or
pending enrollment is persisted; reload/closure can lose an uncertain registration.
Keep the tab open and retry Create until the identity is saved.

## Browsing and uploads

The library owns searches, media items, and preview selection (item ID and opener).
The Library view passes the selected card directly to the dialog; its content,
loading, error, and progress state have one source of truth. Session and request cancellation suppress stale results. Pagination uses the submitted query and
permits one request at a time. The separate uploads store owns sequential batches
and refreshes the submitted search after completion. Individual failures do not
stop a batch; only failure names/messages remain for manual resubmission through
Upload. Progress and completion notices are transient. Identity changes and
root disposal cancel batches and clear their state; navigation does not.

Media items own preview leases, small thumbnail URLs, bounded text and mutation
busy state. Session-owned streams retain download sources independently of views.
Disposal aborts previews and revokes thumbnails; stale results cannot publish text
or leases. Cancellation releases busy state without clearing a newer operation.
The API authenticates complete 4 MiB + tag chunks before exposing requested
plaintext ranges of at most 4 MiB. Native HTTP caching retains ciphertext;
the application never caches complete decrypted files.

Metadata updates merge name/tag patches while retaining unrelated metadata and
thumbnails. Conflicts load current metadata and leave failed editor drafts for
retry. Filename editing saves with Enter, cancels with Escape, and discards the
draft on blur without saving. Tag editing preserves failed drafts and compares
tags by protocol normalization while keeping their first spelling.

The preview dialog uses native image/audio/video elements. Navigation follows
loaded result order, skips deleted items and ordinary files, and stops at loaded
boundaries without wrapping or fetching pages. Close the preview and choose More
to load another page. Selection immediately displays the new item's streaming URL,
thumbnail, or filename placeholder; failures offer Retry. Navigation and close
cancel pending preview downloads, and late results cannot reopen the dialog.
The library owns one preview cancellation controller, aborted on switching, close,
search replacement, leaving Library, and session disposal. Explicit downloads
remain independently owned by the session. Navigation works during loading, and
card/dialog always share progress. Unknown progress displays “Loading…”. Players pause
on navigation or close; focus returns to the opening control when available.

## Direct media links

Fresh `#/media/<file id>` tabs load their own session but do not create
the browsing workspace or request lists/tags. A viewer store reads one encrypted
metadata summary, owns one media-item store, and releases it on navigation or
context changes. Explicit downloads have independent session-owned sources. Native
players start on user action. Text remains escaped and bounded; other files offer
Download. The app URL stays stable. Setup can complete inline without losing the
target. Navigating to Library lazily creates the workspace, which then retains its
ordinary root-owned lifetime. See [deeplinks](deeplinks.md).

## Settings and pairing

The workspace owns its quota store and starts its initial read independently of
Settings. Navigation preserves it; ending the workspace disposes it. Reads are
deduplicated, aborted on identity/server/session changes, and protected from stale
completion. Upload size is governed by remaining total storage capacity. Usage also refreshes on entering configured
Settings, after session mutations, and after upload batches finish while Settings
is open. The application forwards quota and uploads directly to Settings;
Settings never receives its owning workspace. Settings shows the CLI-compatible base64url public
key and total usage. Errors and Retry appear beside usage; there is no
polling or persistent quota cache.

The pairing store owns one isolated attempt, relay requests, expiry, approval,
and cancellation. Both devices compare verification codes; the receiver saves
its encrypted identity before acknowledgment. Session invalidation or root
disposal ends the attempt. See [pairing](pairing.md) for protocol details.

## Upload compression

A root-owned preferences store asynchronously saves the device-local `compressImages`
boolean in IndexedDB, separately from identity and excluded from recovery
and pairing. It defaults to true. Selection, paste, drop and extension handoff start
uploads immediately, snapshotting the preference for the sequential batch.

JPEG/PNG/BMP inputs compress to WebP at quality 85 before encryption without
resizing. Only smaller output replaces the original; unsupported, failed or larger
output keeps the original with a notice. Other formats, including videos, remain
unchanged. Files above 32 MiB bypass image compression, image thumbnails and audio
artwork extraction with a notice. Video thumbnails use the original File and native
browser decoder at any size, with an eight-second deadline and cancellation. Transport reads/encrypts sequential 4 MiB slices.
There is no per-file quota policy.

The store shows preparing/uploading phases and actual selected filenames, ignores
late or invalid progress, and clamps percentages. Root-owned work survives navigation;
session disposal cancels it and clears queued files. Processed files are removed
from the owned queue; bitmaps close even on cancellation. Individual failures do
not stop the batch. See [upload simplification](upload-simplification.md).

## Text previews

Text MIME types, JSON/XML and common text/code filename extensions open in the
media dialog as escaped read-only text. Existing image/audio/video types retain
their native viewers. The item owns an escaped UTF-8 prefix of at most 256 KiB,
read from authenticated chunks without downloading the remainder. Truncated
previews are labeled. Download streams the complete file independently. Disposal
clears text and releases the preview lease.

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

Settings sections are native disclosures; only the library/setup section opens
by default. Image compression and size policy share one preparation interface.
See [upload refinements](upload-polish.md).

## Chunk content resources

The unlocked application context owns the content-stream store even on a fresh
deeplink route without a workspace. Views receive it explicitly. Preview leases
end when their owning item/caller ends; native downloads retain their own source
until completion/cancellation and survive view navigation. Context changes dispose
all streams and abort bounded chunk reads. Deletion invalidates every stream for
that file. Neither keys nor authenticated requests run in the service worker; it
bridges bounded plaintext ranges to the owning page through MessageChannels.
