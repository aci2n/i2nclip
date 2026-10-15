# Structured-clone file handoff

## Goal, scope, and exclusions

Send a native File from the Firefox extension to the app instead of base64.
Remove binary/string conversions, padding validation, and reconstruction. Keep
capture naming, persistent tabs, focus only for unlock, hidden pending files,
automatic uploads, notifications, and the existing 32 MiB bound. No protocol
fallback, dependency, credential caching, session binding, server API change,
new permissions, or commit without user confirmation.

## Interfaces and ownership

The extension downloads bounded chunks and creates the final named File directly.
A self-contained injected installer registers one runtime message handler per app
document, guarded in the isolated content-script global. The background injects
the installer then uses tabs.sendMessage to the top frame with the app URL,
request, and acknowledgement timeout. Runtime messaging and window.postMessage
carry the File through structured cloning. The bridge validates its extension
sender and target origin/path, correlates app replies, and reports completion.
The root receiver accepts only a File within the size bound and delegates it to
the ordinary library workflow. The app continues to own credentials/encryption.

## Persistence, lifecycle, and failures

No new saved state. The installed handler belongs to the document; individual
requests own reply timers and message/pagehide listeners until rejection,
timeout, navigation, cancellation, or completion. Runtime delivery errors fail
the capture without retry; loading/admission polling remains unchanged. Locked
files, invalidation, and notification behavior remain unchanged. Use the library
active at delivery; do not add probe-time session binding. Receiver file size is
checked without reading bytes. Old base64 messages are unsupported.

## Acceptance checks

Existing capture/receiver fixtures use File objects and assert names, MIME,
bytes, size rejection, hidden pending ownership, and completion cleanup. Browser
fixtures construct Files in the page before posting messages. No test cases are
added or run unless requested. Svelte checker/build and static checks pass;
rebuild the extension package. Leave all edits uncommitted for review.
