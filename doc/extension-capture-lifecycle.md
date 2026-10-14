# Background capture and temporary popup lifecycle

## Goal and scope

Capture into an unlocked web app without changing browser focus. If no admitted
app tab exists, create a 440×640 temporary popup, initially unfocused. Focus only
when the accepted file is waiting for unlock. Keep a single pending file hidden
in the app's memory while locked; submit it automatically through the ordinary
library upload as soon as unlock finishes. Remove the pending-file component,
its filename/status state, and manual Upload/Cancel actions.

Use the existing app-root receiver, window event protocol, and upload store.
No identities, encryption, queues, persistent files, additional locks, or
dependencies move into the extension. Regular app tabs are never closed.

## Communication investigation and interfaces

Firefox does not expose webpage `runtime.connect` or `runtime.sendMessage` through
`externally_connectable`. A persistent startup connection would require a content
script and a connection registry/reconnection lifecycle. Keep the current root
listener registered after Web Lock admission and the transient injected bridge;
query only the configured app URL rather than every tab. Filter exact origin/path
and probe admission as before. An existing blocked/loading app tab must not cause
another popup to be created.

The accepted-file reply includes `needsUnlock`. Use the final receipt state, so
locking or unlocking during media fetching does not focus an already unlocked
app or miss a newly locked one. Only success acknowledgements trigger focus.

For a newly created popup, the injected bridge listens for a correlated completion
event after acceptance. The receiver emits it when the ordinary upload finishes.
The bridge notifies its own extension using `runtime.sendMessage`; the background
validates extension ID, top-frame sender, configured URL, popup type, and the
specific created window ID before closing that window. Event-driven completion
can wake Firefox's background page after it idles, avoiding persistent job state
or polling. Remove listeners after rejection, completion, timeout, or pagehide.

## Ownership, persistence, and cancellation

The root receiver owns one hidden pending file plus its reply correlation. Unlock
may publish an unlocked state while still busy; wait until the session is idle
and configured and the library is idle before starting. Clear pending ownership
before starting the upload to prevent duplicate submission from store updates.
Failed unlock retains the pending file. Epoch changes, root disposal, reload, or
manual popup closure discard it; never submit into a replacement identity.

The popup closes only after a successful upload, not after acknowledgement.
Upload failures leave it open with regular library failure messages. Initial
setup, fetch/bridge failures, and manual closure also leave no automatic retry.
Lost acknowledgements still require checking the app before retrying. Closing
the popup cancels root-owned work through existing disposal behavior.

Only `appUrl` persists in extension storage. No completion registry is saved;
only the temporary bridge owns the created window's completion listener. Existing
app tabs have neither the completion listener nor close-on-success behavior.

## Acceptance checks

- Existing unlocked apps receive uploads without tab/window activation.
- Newly created popups use 440×640 and `focused: false`; focus only on a final
  `needsUnlock` receipt. Requests rejected before acceptance never steal focus.
- Locked screenshots in both themes at 320/360 show only the ordinary unlock UI,
  without captured filename, pending status, or extra actions.
- Unlock automatically uploads exactly once, including its busy-state transition;
  failed unlock does not upload, and epoch invalidation/disposal discards pending
  captures. Ordinary progress, failures, and byte-identical downloads still work.
- Completion closes only the extension-created popup after success, leaves
  failures and ordinary tabs open, and cleans up transient listeners.
- Build/checker are warning-free, meaningful isolated unit/browser tests pass,
  package/static checks pass, and generated artifacts are rebuilt.

Reference: [Firefox externally_connectable](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable).
