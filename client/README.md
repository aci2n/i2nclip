# Frontend audit guide

This is a Svelte 5 + Vite application shared by a browser page and a Firefox
extension. It does not use SvelteKit routing or server rendering. The public
JavaScript API remains `src/lib/index.js`.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/App.svelte` | Compose the application and dispose it on unmount |
| `src/lib/views/` | Library, Settings, and Upload page markup |
| `src/lib/components/` | Cards, inline tags, unlocking, and the image dialog |
| `src/lib/stores/` | State transitions, async actions, cancellation, and resource ownership |
| `src/lib/stores/dom.js` | Small browser adapters for focus, dialogs, validation, and file selection |
| `src/lib/protocol/` | Identity, encryption, tag normalization, framing, and recovery format |
| `src/lib/api.js` | Signed HTTP requests and encrypted API payloads |
| `src/lib/media/` | Bounded reads, media preparation, thumbnails, cover art, and formatting |
| `src/lib/platform/web.js` | Browser storage, downloads, and confirmation adapter |
| `src/extension/` | Firefox APIs, context menus, and extension entry points |
| `src/app.css` | Theme tokens, typography, and shared controls; component styles stay scoped |

Views render store values and invoke actions. Local input drafts are allowed;
components do not fetch, touch storage, manage object URLs, or await workflows.
The tag editor creates a view-scoped store and disposes its presentation state
on unmount. Its save action delegates to the library and media stores.

## Ownership and transitions

- **Application:** creates the session and settings stores; retains one library
  across Library/Settings navigation. Context-menu windows also retain one
  pending upload and its tag draft across views and history; their Upload link
  preserves the source ID. Application disposal releases both workflows.
- **Session:** loading → configured/locked/unlocked. Only one mutation can run
  locally, and the `i2nclip-session` Web Lock serializes mutations across pages.
  Each mutation rereads persistent storage inside the lock. Refresh revisions
  ignore old snapshots; disposal aborts work before further writes.
- **Library search:** idle → loading → results/empty/error. A new search aborts
  its predecessor and changes the revision. More uses the submitted query,
  permits one request, and deduplicates overlapping IDs. Replacing results or
  changing credentials disposes media stores and clears the preview.
- **Upload batch:** idle → uploading one file at a time → idle with failed files.
  Failed files keep their source for retry. Each attempt encrypts with a fresh
  nonce, so retrying normally creates a new content hash. An exact sealed
  payload duplicate returns a conflict; after a lost successful response,
  refresh the library before retrying to avoid creating another copy. Credentials changes abort
  the batch, clear retry sources, and prevent late completions from refreshing
  another library. Progress is accepted only for the active batch and file.
- **Media:** idle → one of reveal/download/retag/delete → idle or deleted.
  One action at a time; decrypted bytes and URLs belong to the media store.
  Cached bytes survive navigation. Disposal aborts downloads and revokes URLs;
  deleted cards remain faded until the next search.
- **Popup:** preparing → available → uploading → uploaded, or available with an
  error. Automatic upload waits for both preparation and unlocking and starts
  once. A failed automatic attempt requires an explicit retry. Tagged popups
  wait for submission after unlocking. Successful upload removes only its own
  source ID. A library/server change during preparation disables automatic send
  until explicit submission. Superseded requests cannot update progress or close
  the window.
- **Context menu:** persist a source with its own ID before uploading or opening
  a popup. Immediate upload success removes that ID; failure retains it and opens
  a popup with the error for explicit retry. Library changes cancel the transfer,
  and reset-cleared sources are not recreated. Notification failure after success
  does not trigger retry.
- **Tags:** closed → editing → saving → editing or closed. Failed drafts survive
  blur; newer drafts are not cleared by an older save. Escape cancels. Normalized
  duplicates preserve the first spelling. Unmounted editors cannot steal focus.

The stores use ordinary JavaScript and Svelte's readable store contract so the
async transitions can be tested directly with deferred promises, without a
component compiler or a separate state-machine dependency.

Creation persists `pendingRegistration` (server URL, public key, and wrapped
private key) before contacting the API. Retries unwrap the same identity and
use a signed list request to confirm registration before spending an invitation.
The password and invitation are not persisted. The final local identity and
cleared pending marker are written together; a session-write failure leaves a
locked identity that can be unlocked or backed up. Pending creation must be
finished or explicitly discarded before restoring or changing servers.

Tab-injected media fetches register a separate abort controller per request in
the extension's isolated frame context. Caller cancellation aborts the remote
fetch; completion and failure release the stream reader and remove frame state.

The upload path is:

```mermaid
flowchart LR
    Menu[Context menu] --> Queue[submitContextUpload: save source]
    Queue -->|unlocked| Transfer[sendPendingUpload]
    Queue -->|tags or locked| Popup[createPendingUpload: preview and retry]
    Popup --> Transfer
    Transfer --> Send[sendUpload: prepare, encrypt, POST]
    Library[Library file batch] --> Send
```

- `context-upload.js` saves a source under its own ID and chooses immediate
  transfer or a popup. It records a failure and opens explicit retry.
- `pending-upload.js` owns popup preparation, preview URLs, tags submission,
  and retry. Its `sendPendingUpload` function is shared with immediate uploads:
  capture credentials, abort if they change, send, clear only this pending ID,
  and notify. The popup alone decides when to close.
- `media/upload.js` accepts named options, reads bounded bytes, generates a
  thumbnail, and calls the encryption/API layer. A prepared source reuses its
  blob, so upload retries do not fetch it again.
- Library uploads keep sequential batch progress and failed files in the
  library store, and call the same `sendUpload` function.

Pending sources are retained after both preparation and transfer failures.
Preparation failures retry only on explicit submission, including unlock popups.
Retries encrypt again with fresh randomness, creating a new content hash. A lost
successful upload response can therefore lead to a duplicate item on retry;
check the library before retrying an ambiguous failure. The server returns 409
only when the same sealed-content hash is posted again.


## Verification

Use the Node version in `.nvmrc`, then `npm ci --prefix client` from the repo root.
`make test` runs client tests, the Svelte checker, and Rust tests.
`make extension` builds the XPI without minifying JS or CSS.
`npm run e2e --prefix client` rebuilds and runs Firefox against the real local API.

Browser tests are split by settings, library, and popup behavior. `e2e/fixtures.js`
owns the API server, storage shim, and shared helpers. Screenshots are written to
ignored `e2e/shots/`; review both themes at desktop, 360 px, and 320 px widths.
The mixed-media test includes landscape, portrait, panorama, playable WAV/WebM,
long names, files, and playback controls. Its video fixture is a one-second test
pattern; FFmpeg is not needed to run tests.

Deferred-promise tests exercise ignored cancellation, stale search and upload
completion, old progress callbacks, identity/server changes, disposal, duplicate
submissions, overlapping pages, and failure/retry. Firefox tests cover form
validation, recovery failures, encryption flows, navigation, modal focus,
inline editing, upload errors, and layout constraints.

Organization follows the shared `src/lib` convention from
[SvelteKit's structure guide](https://svelte.dev/docs/kit/project-structure),
without adding SvelteKit to this Vite project. See also Svelte's guidance on
[stores for async flows](https://svelte.dev/docs/svelte/stores) and
[derived state, effects, props, and scoped styles](https://svelte.dev/docs/svelte/best-practices).
