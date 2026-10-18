# Private media deeplinks

## Goal, scope, and exclusions

Open an individual library file at `#/media/<lowercase SHA-256>` in a
separate tab. Keep the stable app URL and a minimal full-page viewer with native
image/audio/video elements; text uses the existing escaped bounded preview and
other files offer Download. Keep the existing library preview and add a normal
Link anchor styled like the adjacent action buttons for each nondeleted card. Links identify a file; they do
not grant access or contain keys, server addresses, or plaintext metadata.
Public sharing, blob-URL redirects, autoplay, PDF/HTML document embedding,
streaming decryption, new dependencies, schema changes, and changes to the
encryption protocol are excluded.

## Interfaces and ownership

Add authenticated GET /api/media/{id}/meta returning the same encrypted media
summary as list entries, and an owner-filtered database metadata lookup that does
not fetch content bytes. Invalid IDs return 400; missing/other-owner files return
404. Existing signed-empty-request, registration, replay, and no-store policies
apply. PUT on that path and content GET on /api/media/{id} retain their contracts.
The client getMedia request decrypts the summary and checks the requested ID.

A dedicated viewer store receives one fixed LibraryContext and item ID. It owns
metadata requests, a reused media-item store, subscriptions, retry, download, and
disposal. A view subscribes and passes ordinary state/callbacks to the presentation
component. No component accesses stores or owns async application workflows.
Fresh viewer tabs must not create the browsing workspace or request lists/tags.
The root still owns any existing browsing workspace across navigation so uploads
survive. Viewer stores end on navigation, ID/context changes, and disposal.

## Persistence and lifecycle

Use the existing shared unlock flow with password fallback, retaining the target
URL. If no library is configured, show normal setup inline and resume once a
configured context exists. Malformed links display an actionable error without
requests. No new persisted state or session coordination is introduced.

After metadata resolves, download the complete content, verify its sealed-content
hash, and decrypt through existing code. Show Loading metadata, Loading N% when
known, Loading otherwise, and Preparing once download reaches 100% while work is
still pending. Display content only after preparation finishes. Playback starts
on user action. Ordinary files are not automatically saved; Download is explicit
and uses the existing filename logic. Unknown or damaged metadata fails with Retry.
Missing/other-owner/deleted files show a not-found message and Library action.
Network/content/decode failures appear beside Retry/Download. HTML/XML/code is
escaped text; SVG stays an image. Unsupported native codecs offer Download.

Abort metadata/content work and revoke item URLs on disposal or session end;
late results cannot create URLs, publish state, or trigger a save. Retry is
single-flight. Completed bytes/URLs are reused only within the viewer lifetime.
Navigation to Library preserves the unlocked session and lazily creates its
workspace. Back/Forward resolves the current URL and cancels superseded viewers.

## Acceptance checks

API tests cover authentication, owner isolation, empty bodies, ID validation,
not-found/deletion and encrypted response shape. Client tests cover metadata
opening, error propagation, invalid IDs, progress/retry, supersession, session
abort, late results and URL disposal. Real Firefox/Chromium tests cover inherited
unlock and password fallback, stable reload/Back/Forward, direct item reads without
list/tag queries, image/audio/video/text/files, explicit downloads, failure/retry,
missing IDs, and identity invalidation during loading. Inspect actual Firefox
screenshots with realistic aspect ratios, long names/errors, both themes, and
320/360 px widths. Build warning-free before cohesive commits. Run make test-all
using the documented Node/toolchain/container/browser prerequisites.

## Shared media presentation

MediaDialog and MediaViewer use one MediaContent component for escaped bounded
text, images, audio/video controls, artwork, unsupported-file fallback, decoding
errors, and playback cleanup. It receives plain MediaState and a dialog/page
presentation prop. Dialog chrome, loading/retry, navigation and swipe handling
remain in MediaDialog; page chrome and loading/retry remain in MediaViewer.
Dialog playback retains autoplay; pages require user action. Changing items or
unmounting pauses the old player. Stores retain all bytes, URLs and cancellation
ownership; this refactor adds no persistence or application workflows.

The card action remains a native anchor with target blank and its stable href,
labelled Link. Shared button control styles apply equally to anchors and buttons,
including focus, theme, compact spacing and narrow-screen touch size. Native copy
link/open actions remain available. Check equal computed styles beside Download
in both themes and at desktop/320/360 widths; inspect Firefox screenshots and run
existing playback, text, loading and viewer browser coverage.
