# Minimal Firefox upload bridge

## Goal and history

Restore right-click capture without restoring a second application. Commit
`bfdd658` removed an extension that instantiated a service engine and repository,
owned identities and library menus, and opened its own upload windows. The
simplification plan explicitly anticipated a future extension as a web-app bridge.

## Scope and exclusions

One Firefox Manifest V3 extension offers **Upload to i2nclip** for HTTP(S) images,
audio, and video. Its options contain only the web-app URL. It downloads one
resource, focuses an existing tab at that app origin/path or opens one, and hands
the bytes to the admitted web app. The web app uses its existing upload workflow.

Exclude extension identities, crypto, API calls, library/tag UI, workers, queues,
persisted files, upload retries, source-page injection, blob/data URLs, linked-file
capture, authenticated media fallbacks, Chrome packaging, and publishing/signing.
The extension fetches HTTP(S) resources without credentials; protected media may
require downloading manually and using the app's Upload action.

## Interfaces and ownership

- Extension source lives in `client/extension/`, with no additional npm project
  or dependencies. `make extension` copies these plain files and packages them in
  `client/dist/i2nclip-extension.zip`; the server image still contains only web.
- Extension storage owns only `appUrl`. Require HTTPS, permitting HTTP loopback
  for development. Remove query/hash when saving; prohibit URL credentials.
- Background owns a single capture at a time, tab selection, a 30-second capped
  streaming download, and errors via a browser notification. Check the app before
  fetching. Reuse the admitted tab when multiple matching tabs exist; never close
  tabs automatically. Tab discovery/waiting and bridge replies have deadlines.
- An ephemeral injected content script sends a versioned, correlated same-origin
  `window.postMessage` request and waits for an acknowledgement. Injection checks
  the configured origin/path again to prevent handoff after tab navigation.
  File bytes use base64 because scripting arguments must be JSON serializable.
  There are no permanent content scripts or externally callable extension APIs.
- An application-root store registers the receiver only after Web Lock admission.
  It validates source, origin, message shape, filename, MIME type, and the existing
  32 MiB limit before accepting a file. Components receive plain state/callbacks.
- If unlocked and configured, switch to Library and start the existing upload.
  A locked app retains one file in memory and displays its name plus Upload and
  Cancel. Upload requires an unlocked, configured, idle session and idle library.
  A client requiring initial setup rejects capture with instructions to set up
  the library and retry. Acknowledgement means accepted, not uploaded; the app
  owns progress, completion, and errors after acceptance.

## Persistence, lifecycle, and failure cases

Only the app URL survives an extension restart. No identity or file is stored by
the extension. A pending file survives view navigation and unlocking, but is
discarded on Cancel, reload, tab close, root disposal, or session epoch change
(including Lock, Forget, Reset, identity/server replacement). Existing upload
cancellation and failure behavior stays authoritative.

Reject overlapping captures, a second pending file, session mutations, and active
upload batches. Reject malformed/oversized messages without allocating decoded
bytes. Cancel the response stream on HTTP failure, overflow, timeout, or read
failure. An unavailable, blocked, outdated, closed, or navigated app tab produces
a clear notification. Never retry a handoff automatically: a lost acknowledgement
may mean the file was already accepted; instruct users to check the app.

## Acceptance checks

- Reuse an existing admitted app tab; create one when absent; focus its window.
- Ignore unrelated origins/paths and refuse handoff after navigation.
- Receive a real file through the bridge and upload/download identical bytes
  through the real web/API workflow; encryption remains in the web app.
- Locked receipt, unlock then Upload, Cancel, busy rejection, stale session
  cleanup, and disposal do not leak files or trigger unintended uploads.
- Enforce the limit during streaming even with missing/incorrect Content-Length;
  cancel owned streams on failures. Reject unsupported source URL schemes.
- Package contains only the small extension; web archive remains independent.
- Build and Svelte checker have no warnings; meaningful isolated unit tests cover
  bridge/ownership/download behavior. Firefox screenshots review the pending UI
  with long filenames at 320/360 px in both themes. Browser verification uses the
  existing real server/database fixtures. Manual Firefox installation verifies
  browser permissions and the native context menu when automation cannot load
  Firefox extensions.

API reference: [Mozilla scripting.executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript).
