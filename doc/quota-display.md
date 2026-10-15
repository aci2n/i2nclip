# Library quota display

## Goal and interfaces

Expose signed GET `/api/quota`, returning only the authenticated key's
`max_content_bytes`, `max_files`, `used_content_bytes`, and `file_count` as JSON
numbers with Cache-Control: no-store. Require a signed empty body, consuming the
nonce and applying the existing GET size/deadline policy. Return the existing
authentication/not-found errors; never accept an owner identifier from callers.
Database access stays in Database; reuse the media request authentication policy.

## Client ownership and lifecycle

Add a protocol API call and a Settings-owned quota store. The store owns requests,
cancellation, loading/error state, and stale-result checks against the session
epoch. Dispose it on leaving Settings, and clear/abort on identity changes or
locking. Views subscribe and invoke store callbacks; components receive no store
or async workflow. Nothing is persisted and uploads remain root-owned.

Refresh on entering configured Settings, after session mutations, and when a
root-owned upload batch finishes while Settings is open. Deduplicate requests.
Display Storage: used of limit and Files: count of limit in Your library, using
existing size formatting and readable count separators. Keep loading and error
messages beside these values; Retry retries a failed request. Do not poll or add
a dashboard, quota editor, usage progress bar, or dependencies.

## Acceptance checks

Test owner isolation, signatures/replay, nonempty-body rejection, response cache
policy, and usage changing after uploads/deletes. Test store cancellation, stale
results, deduplication, and retry. Use real server/browser tests for initial usage,
upload/delete refresh, offline error/retry, and no IDs or horizontal overflow.
Inspect Firefox screenshots at desktop and 320/360px in both themes. Run client
tests/checker/build, Rust checks and relevant PostgreSQL tests, then commit this
feature separately from quotas, transfer permits, and IP rate limiting.
