> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# Pairing and session simplification

## Goal and scope
Make session ownership and pairing cancellation readable by removing the separate
identity context, registered session operations, and callback-based identity access.
Session owns identity, persistence, mutation serialization, and its existing lifetime
signal/epoch. Pairing owns one task, its controller, relay, crypto, timers, and a
subscription that cancels the task when the session changes.

## Interfaces and ownership
Replace operation/withIdentity with direct identity() access guarded by session
readiness. importPairing returns success/failure, like other session mutations.
Pairing checks its task before/after asynchronous work; reading an identity does
not extend its lifetime. Pairing watches epoch, server, configured, and unlocked
state. Dispose the watcher with the task. Remove identity-context.ts and its test
helper rather than retaining compatibility interfaces.

## Persistence and lifecycle
Keep encrypted persistence and root-owned session/pairing lifetimes unchanged.
Receiver validation happens before detaching its old session watcher. Detach only
for the intentional identity import, whose session action already guards external
invalidation and cancellation. After a successful save, watch the new session for
the acknowledgment. Cancellation must prevent stale publication or transfer.

## Failures and cancellation
Preserve lock/reset/external-tab invalidation, cancellation during crypto/network
work, expiration, bounded relay cleanup including late room creation, retry rules,
and the distinction between failure before saving and failure confirming a saved
identity. Failed imports must not send acknowledgments. Overlapping session
mutations remain rejected. No new persistence or cross-tab coordination.

## Exclusions
No protocol, crypto, relay, storage format, UI, dependency, or server changes.
Do not change unrelated working-tree edits.

## Acceptance checks
Run the client behavior tests and checker and build the client without warnings.
Existing pairing checks must preserve successful transfer, approval, cancellation,
external invalidation, retries, late room cleanup, and save/acknowledgment failures.
Add focused coverage where removal of operations leaves a lifecycle gap.
