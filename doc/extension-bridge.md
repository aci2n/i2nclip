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

### Firefox settings simplification

Goal: configure the single app URL inside Firefox's standard `about:addons`
settings container. Set `options_ui.open_in_tab` to false, remove all extension
CSS and page decoration, and retain only a semantic HTML form with a URL label,
input, Save button, and status output. A `color-scheme` meta tag enables native
light/dark controls. Firefox requires extension-owned HTML; Manifest V3 no longer
supports `browser_style`, so do not add browser-internal stylesheets, copied
Firefox styles, UI frameworks, or a settings schema/generator.

The options script continues to own loading, validating, and saving only `appUrl`
through extension storage. Validation/storage failures remain beside Save and
must preserve the last saved value. The form has no long-running work or pending
files; closing settings discards unsaved input. No capture, handoff, upload,
identity, protocol, or storage-format changes are included.

Acceptance: the rebuilt archive contains no CSS; preferences open within
`about:addons`; Save normalizes and persists a valid URL; invalid input shows an
error without overwriting storage; reopening loads the saved URL. Inspect actual
Firefox light/dark settings screenshots and run packaging/static checks.

Verified in a disposable native Firefox profile: Preferences embeds the form in
`about:addons`, both light/dark screenshots were inspected, and
`http://localhost:8080/?page=settings#test` saves as `http://localhost:8080/`.
Saving a non-loopback HTTP URL reports an error; reopening retains the localhost
URL. Package checks, lint, and formatting pass. HTTP loopback admission remains
the existing policy (`localhost`, `127.0.0.1`, and `[::1]`).

References: [Firefox options_ui](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/options_ui),
[uBlock Origin manifest](https://github.com/gorhill/uBlock/blob/master/platform/firefox/manifest.json),
[Privacy Badger manifest](https://github.com/EFForg/privacybadger/blob/master/src/manifest.json).

### Upload bridge

- Extension source lives in `client/extension/`, with no additional npm project
  or dependencies. `make extension` copies these plain files and packages them in
  `client/dist/i2nclip-extension.zip`; the server image still contains only web.
- Extension storage owns only `appUrl`. Require HTTPS, permitting HTTP loopback
  for development. Remove query/hash when saving; prohibit URL credentials.
- Recreate the single context-menu item on background startup, including temporary
  add-on reloads; menu availability must not depend on an install event.
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

## Implemented verification

- `make -C client test`: 76 meaningful unit cases pass; Svelte checker reports
  zero errors and warnings. This includes menu creation without an install event,
  file validation, pending-file disposal, streaming overflow, and single handoff.
- `make test-packages`, client lint, and client formatting checks pass.
- `make test-e2e`: all 14 Firefox/Chromium cases pass against the real server and
  isolated databases, including bridge receipt and byte-identical downloads.
- Actual Firefox screenshots of the long pending filename at 320/360 px were
  inspected in both themes; no horizontal overflow or clipped actions.
- A fresh native Firefox profile loaded the generated temporary extension and
  displayed **Upload to i2nclip** as a visible image context-menu item, with no
  extension errors in the browser console. Reload a temporary add-on through
  `about:debugging` after rebuilding it.
