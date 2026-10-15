# Background capture and persistent app tab lifecycle

## Goal and scope

Reuse an existing app tab or create a regular persistent tab when none exists.
Create it inactive; activate its tab and focus its window only when the accepted
capture needs unlocking. Keep the tab open after success, failure, or rejection.
Remove temporary-window IDs, popup creation, and completion-driven window closure.
No credential caching, new storage, transport changes, dependencies, or UI changes.

## Interfaces and ownership

The extension uses `tabs.query`, exact origin/path matching, and the existing
admission probe. If no matching tab exists, `tabs.create({ url, active: false })`
provides the candidate. Existing loading/blocked tabs do not create duplicates.
The transient injected bridge reports upload completion only for notifications;
it carries no window ownership. The app root and library store continue to own
pending files, unlocking, upload workflows, and cancellation. No app interfaces
or manifest permissions change.

## Persistence, failure, and cancellation

A new tab stays open until the user closes it. Its unlocked credentials remain
in app memory and follow the ordinary Lock/reload/session lifecycle. Only appUrl
persists in extension storage; files and completion listeners remain transient.
A locked app holds one hidden file, uploading automatically after successful
unlock. Session invalidation and disposal discard pending captures. Closing the
tab disposes root-owned work. Fetch/probe/receipt/upload failures leave the tab
open, report existing errors, and never retry automatically. Completion sends
success/failure notifications; cancellation is silent. Neither result closes tabs.

## Acceptance checks

- Existing matching tabs are reused and absent apps create one inactive regular tab.
- Only accepted captures requiring unlock activate a tab and focus its window.
- No popup creation, temporary-window protocol fields, or automatic closure remain.
- Hidden pending captures and automatic upload after unlock remain unchanged.
- Completion still notifies success/failure and releases transient listeners.
- Existing test expectations reflect persistent tabs; build/checker are warning-free
  and the extension package is rebuilt. No additional tests are introduced.
