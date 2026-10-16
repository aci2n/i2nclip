# Tag review fixes

Historical change specification: its incremental migrations and empty-label
support were superseded by the [fresh database baseline](database-rebuild.md).

## Goal, scope and exclusions

Fix three findings in separate verified commits: increase encrypted-label limits,
retain catalog refreshes requested during busy sessions, and remove duplicate
screenshot theme handling. Preserve original tag spelling and client normalization.
No dependencies, polling, cache, backfill, UI redesign or deployment is included.

## Interfaces and ownership

The server accepts sealed labels of 30–1024 bytes and tag JSON up to 96 KiB,
still allowing at most 64 entries. Request-body limits remain derived from the
field limits. A new SQLx migration widens the label check without modifying
applied migrations or data. Wire shapes, encryption and owner scoping stay intact.

The root-owned tag store replaces ready with a refresh-needed flag. It starts
true, becomes false when a request starts, and becomes true when an unlocked,
configured but busy session receives a refresh request. The session subscription
starts one refresh when busy clears. Repeated deferred requests coalesce.
Existing suggestions remain usable while waiting. Components gain no workflow.

The automatic-tag browser test calls shot once per width. The shared helper
continues to capture light and dark themes, yielding four screenshots overall.

## Persistence, lifecycle and failures

Migration 003 preserves existing nonempty and empty labels; reopening the database
keeps them intact. Client spellings remain byte-for-byte unchanged. No backfill.
Catalog invalidation aborts requests, clears decrypted labels and marks the new
session for initial refresh. Disposal discards deferred work. Supersession and
stale-result checks remain intact. Network errors retain existing suggestions
and require explicit retry; they do not trigger automatic retry loops. A deferred
refresh returns false immediately, then is serviced when the session is available.

## Acceptance

Verify decomposed Unicode tags through real upload, metadata update, search and
catalog decryption, preserving spelling. Test 1024/1025-byte labels, 64 maximum
labels in a frame, tag-field and HTTP body boundaries, and migration preservation.
The existing old-schema fixture must replay all migrations after its reset.
Test busy/refresh/idle coalescing, identity invalidation, disposal and request
failure. Check four automatic-tag screenshots and inspect Firefox output.
Run focused checks and warning-free builds before each commit, then make test-all.

## Verification completed

Focused label/migration and HTTP body-boundary tests passed, along with the real
Unicode upload/update/catalog regression in Firefox and Chromium. Catalog tests
cover deferred coalescing, retained suggestions, explicit retry, lock and disposal.
Final make test-all passed, including client tests, Svelte checks with zero
errors/warnings, Clippy, formatting, web/extension builds, PostgreSQL tests and
64 browser cases. Each browser produced exactly four automatic-tag screenshots;
all four Firefox images were inspected at 320/360px in light/dark themes.
