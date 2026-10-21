> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Storage units and multiple tabs

Historical specification. Session lifetime and unlock behavior are superseded by
[shared sessions](shared-session.md); current ownership is described in [session](session.md).

## Goal and scope

Allow the web app to run in multiple tabs and display large storage quantities in
GB or larger units. This replaces lifetime single-tab admission. Each tab owns its
session, keys, workflows and local busy guards independently.

## Interfaces and ownership

The media formatter chooses the largest binary unit through EB, keeping existing
B/KB/MB formatting and adding one decimal for GB and above. Settings keeps using
that formatter for used and total storage.

Persistence owns detection of changes to the identity localStorage record. The
session owns reacting to those changes: invalidate pending operations, discard
loaded identity and wrapping keys, and show Unlock (or master-password setup if
the record was removed). Application teardown removes the listener. Storage
notifications contain no decrypted identity. Other tabs do not inherit unlocked
keys. Local lock remains local because it does not mutate persisted state.

## Persistence, lifecycle and failures

Preserve the current encrypted record and all wire formats. Listen only to the
identity key, and to localStorage.clear(). Re-read the current record rather than
trusting event payloads. Ignore unrelated storage events. On changes, cancel
session-owned operations and prevent in-flight persistence operations from
writing obsolete state. Compare the current persisted text before committing an
asynchronous write; reject a conflict with an ordinary actionable error. This is
a stale-write check, not a lock or transaction. Simultaneous mutations can race;
no distributed coordination is promised. See [session simplification](session-simplification.md)
for the subsequent removal of the optional pageshow check.
Malformed records display the existing recovery/reset error. Remove listeners on
disposal; never apply stale asynchronous completions.

## Exclusions

No active-tab focusing, shared unlocked sessions, automatic media synchronization,
BroadcastChannel, new dependencies, cross-tab locks, protocol/database changes,
or routing changes. Preferences retain their existing ownership and behavior.

## Acceptance

Unit tests cover unit boundaries through large units, identity changes/removal,
unrelated events, stale writes during async crypto, and listener cleanup. Real
Firefox and Chromium tests open multiple tabs, unlock independently, and verify
password changes and forget invalidate other tabs. Extension captures continue to
work with multiple independently unlocked app tabs. Run strict client checks,
unit/Rust tests, web/extension build checks and browser suites. Inspect Firefox
screenshots of the changed storage text and multiple-tab setup/unlock screens.
