# Firefox extension

## Goal and scope

**Upload to i2nclip** sends a right-clicked image, audio clip, or video to the web
app's ordinary encrypted upload workflow. The extension owns downloading and
handoff; the app owns credentials, encryption, library state, and uploads.

The extension contains no identity storage, encryption, server API client,
library UI, upload queue, automatic retries, or saved files. It supports public
HTTP(S) media up to 32 MiB. Authenticated media and blob/data URLs require saving
the file and using Upload in the app. Firefox is the supported extension target.

## Installation and preferences

Run `make extension` with Node from `client/.nvmrc` and zip installed. Load
`client/dist/extension/manifest.json` through Firefox's `about:debugging`, or use
`client/dist/i2nclip-extension.zip` for signing/distribution. Temporary add-ons
must be loaded again after restarting Firefox. After rebuilding, reload the
add-on in `about:debugging`.

In `about:addons`, select **Upload to i2nclip**, open **Preferences**, and save
**i2nclip URL**: the address used to open the app. HTTPS is required except for
HTTP on localhost, 127.0.0.1, or [::1]. URL credentials are rejected; query and
fragment are removed. The form uses native HTML controls, no CSS, and Firefox's
embedded settings container. Validation/storage failures appear beside Save;
invalid input does not overwrite the saved URL. Closing discards unsaved input.

The existing menus, tabs, storage, scripting, notifications, and HTTP(S) website
permissions support capture and handoff. No additional permissions are needed.

## Capture and filenames

Right-click media and select **Upload to i2nclip**. The context menu is registered
on background startup, including temporary add-on reloads. One capture can be
sent at a time. The extension checks the app before downloading, omits fetch
credentials, limits the download to 30 seconds, and enforces the size bound
while streaming, regardless of Content-Length.

A source-frame script reads only the exact clicked element through
`menus.getTargetElement`. Filename priority is nonblank alt, title, aria-label,
page title, then page URL without credentials. If inspection fails, use the tab
title and frame/page URL. The downloaded URL basename is the final fallback.
Normalize whitespace and filename separators/control characters, cap the final
name at 255 characters, and choose a MIME-appropriate extension when known.

## Tab and upload lifecycle

Reuse a matching app tab, or open an inactive regular tab when absent. Match the
configured origin and path exactly, then probe for the receiver admitted by the
app's Web Lock. Existing loading/blocked tabs do not cause duplicate creation.
Discovery has a 15-second deadline; individual probe replies have a 500 ms
timeout and file receipt has a 5-second timeout.

Keep tabs open after success, rejection, and failure. Activate the app tab and
focus its window only when the final accepted-file reply requires unlocking.
Keep the tab open and unlocked to avoid repeated password prompts.

A locked app holds one capture invisibly in memory. Successful unlock starts
one ordinary upload once the session is configured and idle. Failed unlock
retains it. Setup or busy apps reject capture with instructions; a second pending
capture is rejected. Reload, tab closure, session invalidation, and root disposal
discard pending captures. The library active at delivery is the destination;
there is no probe-time identity binding.

The extension shows success/failure notifications only after upload completion.
Cancellation is silent. The app displays ordinary progress and error messages.
Lost acknowledgements require checking the app before retrying: no automatic
retry may create duplicate uploads.

## File handoff and ownership

`scripting.executeScript` installs one runtime message handler per app document
in the extension's isolated content-script global. `tabs.sendMessage`, targeted
at the top frame, carries the File, app URL, and receipt timeout through structured
cloning. The handler checks the extension sender and current origin/path, then
forwards the File through a correlated same-origin `window.postMessage` request.
No base64 conversion or compatibility protocol is used.

The application-root receiver exists only after tab admission. It checks message
source/origin, correlation shape, File type, and file.size before acceptance,
and delegates to the root-owned library store. Components receive ordinary props
and callbacks. Accepted receipt is distinct from upload completion.

The installed runtime handler belongs to the document. Each request owns its
reply timer and message/pagehide listeners, releasing them after rejection,
timeout, navigation, cancellation, or completion. Completion reaches the
background through runtime messaging and can wake its event page. Only appUrl
persists in extension storage. No credentials or unlock keys enter the extension.

## Text and documentation ownership

User-facing copy describes uploads and gives a next action on failure. Keep
current extension behavior in this specification; avoid separate overlapping
lifecycle, filename, or transport plans and historical test counts. Copy edits
must preserve runtime behavior, permissions, interfaces, and persistence.

## Acceptance checks

- Preferences save/load normalized URLs, reject invalid input, and use native
  controls in light/dark themes without an extension stylesheet.
- The native context menu captures the exact clicked media description.
- Existing tabs are reused; new tabs remain open; only unlock requires focus.
- Files preserve name, MIME, and byte contents across runtime/window messaging.
- Size limits apply during streaming and before app receipt without reading bytes.
- Locked captures remain hidden; unlock uploads once; disposal cancels ownership.
- Completion notifications distinguish success/failure and remain silent on cancel.
- Build/checker and formatting pass; packages contain only their intended files.
- App browser tests cover real API uploads and downloads. Installed Firefox
  verification additionally exercises permissions, runtime messaging, and menus;
  the app's window-message browser test alone does not cover those APIs.

Source is in `client/extension/`, with no separate npm project or dependencies.
The server image contains only the web app; extension outputs stay in client/dist.

References: [Firefox runtime messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/sendMessage),
[structured cloning](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#data_cloning_algorithm),
[embedded options](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/options_ui).

## Source page metadata

Goal: preserve where captured media came from and show a Source link in File
details. Reuse the page URL/title already read from the clicked frame, with the
existing tab/frame fallback. Carry optional source_url/source_title in the file
request's metadata object, retaining it with a hidden pending capture until unlock.
Only HTTP(S) source URLs are stored; strip URL credentials, preserve query/hash,
and omit blank titles. Source context must never use media alt text as page title.

The library upload method accepts an optional metadata object for its batch and
passes it through sendUpload into api.upload. The API helper merges extra JSON
fields before authoritative name/type/size/tags and generated image metadata, so
context cannot override upload invariants. Ordinary Upload is unchanged. Source
fields are inside existing encrypted metadata, including after filename/tag edits;
no server endpoint, schema, dependencies, or persistent extension state changes.
Cancellation/disposal drops context with the pending File through existing paths.

MediaCard derives a safe HTTP(S) link from ordinary metadata props and displays
source_title or the URL in File details. Open in a new tab with no referrer/opener.
Malformed/unsupported stored URLs produce no link. No store/storage/workflow enters
the component. Loading/locked views and notifications never display source context.
Do not scrape page content, fetch source pages, persist extra context separately,
or add compatibility handling. Acceptance: source follows the File through capture,
locked receipt, upload, encryption, and metadata edits; manual files omit it. Check
build/static output and actual Firefox details in both themes and narrow widths.
No tests are added or run unless requested.
