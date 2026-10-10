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
  across Library/Settings navigation. Popups are disposed when leaving their
  view and recreated when returning through history.
- **Session:** loading → configured/locked/unlocked. Only one mutation can run
  locally, and the `i2nclip-session` Web Lock serializes mutations across pages.
  Each mutation rereads persistent storage inside the lock. Refresh revisions
  ignore old snapshots; disposal aborts work before further writes.
- **Library search:** idle → loading → results/empty/error. A new search aborts
  its predecessor and changes the revision. More uses the submitted query,
  permits one request, and deduplicates overlapping IDs. Replacing results or
  changing credentials disposes media stores and clears the preview.
- **Upload batch:** idle → uploading one file at a time → idle with failed files.
  Failed files keep their source and UUID for retry. Duplicate UUIDs return a
  conflict, including retries after a saved upload's response is lost; refresh
  the library to check whether it was saved. Credentials changes abort
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
- **Tags:** closed → editing → saving → editing or closed. Failed drafts survive
  blur; newer drafts are not cleared by an older save. Escape cancels. Normalized
  duplicates preserve the first spelling. Unmounted editors cannot steal focus.

The stores use ordinary JavaScript and Svelte's readable store contract so the
async transitions can be tested directly with deferred promises, without a
component compiler or a separate state-machine dependency.

Upload retries reuse a media ID within the same library. The current server
returns 409 for an existing ID, including a retry after a successful upload whose
response was lost. The frontend surfaces that conflict and retains the failed
source; check the library before retrying further. It does not assume the existing
file is identical or silently generate another ID and duplicate the upload.

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
