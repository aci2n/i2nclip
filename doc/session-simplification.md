> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Simplify session and persistence

Historical specification. Session lifetime and unlock behavior are superseded by
[shared sessions](shared-session.md); current ownership is described in [session](session.md).

## Goal and scope

Reduce duplication and coordination in session.ts and persistence.ts while keeping
independent tabs, encrypted persistence, explicit ownership and cancellation.
The authorized simplification removes the optional pageshow recheck; storage events
remain the mechanism for other-tab changes. No protocol, schema, UI or dependency
changes. No cross-tab locking or new coordination.

## Interfaces and ownership

Persistence owns encrypted records, wrapping keys, and storage-event filtering.
Its notification reports a change; the owning session locks persistence and
invalidates application work. Avoid invalidating the same resources in both places.
Session owns loaded identity, operation cancellation and published state. Share
reset/lock/disposal state cleanup and saved-record status handling rather than
repeating field patches. Share master-password record creation for initialization
and password changes. Keep genuine callback and API contracts explicit.

## Persistence and lifecycle

Retain the current encrypted record format and runtime validation. Reads should
return validated records rather than populate an unnecessary locked-state cache.
Retain the observed encrypted-text baseline and compare it before async commits;
retain cancellation generations so lock/reset cannot be undone by late crypto.
Storage changes discard wrapping and identity keys, cancel work, and show Unlock
or initial setup. Ignore unrelated keys and storage areas; clear() is relevant.
Remove the listener on disposal. Ordinary local Lock stays local.

## Failures and acceptance

Failed writes preserve the previous identity/record. Wrong passwords, malformed
records and unavailable storage retain their errors. Aborted registration,
recovery, pairing and encryption cannot commit or publish late results. Preserve
independent-tab and password-change/forget browser behavior. Update tests to cover
storage notifications instead of the removed pageshow mechanism, retain stale-write
and resource-cleanup cases, and run strict checks, client tests, web/extension
build checks and the real Firefox/Chromium suite. Commit the verified refactor.
