# Backend review

The historical SQLite/filesystem review is superseded by PostgreSQL storage. Current persistence lives in `src/db.rs`; `src/lib.rs` holds shared application state. Protocol validation belongs to `frame.rs`, `crypto.rs`, and the media query parser. Handlers contain no SQL, database mutexes, filesystem operations, or blocking-work dispatch.

Uploads atomically insert sealed content, metadata, and tags. Metadata updates lock the authorized row through UPDATE and replace tags in the same transaction. Deletes cascade tags. Lists fetch metadata and sorted tags in one statement without selecting content, deriving size with `octet_length`. Downloads fetch authorized owned bytes in one statement and return connections before response draining.

Registration consumes invitations and registers keys atomically. Authentication verifies signatures, reserves a nonce asynchronously, and rechecks timestamps after insertion completes, before reading bodies. Failed body verification spends the nonce. Maintenance deletes nonces with `expires < now` and invitations with `expires_at <= now` in one transaction.

Body sizes and read deadlines remain bounded. Two uploads and two downloads are admitted per application instance. Async hashes yield every 64 KiB; SQLx encoding/decoding can still copy complete content values. Full-buffer downloads are intentional. Slow response readers can delay shutdown and occupy download slots indefinitely; timeout work remains in [priorities.md](priorities.md). Storage quotas and proxy rate limiting remain deployment concerns.

Crypto framing and client/server vectors are unchanged. Content hashes bind metadata AAD and are checked before client decryption. Encryption detects corruption but does not provide metadata rollback detection or library completeness proofs.

## Storage test coverage after PostgreSQL migration

Compared with the SQLite tests immediately before commit `e1e91eb`, applicable HTTP coverage remains in `tests/postgres_api.rs`; health coverage now runs without a database in `routes.rs`. Private storage checks live in `db.rs`.

| Former coverage | PostgreSQL coverage |
| --- | --- |
| Owner and AND-tag filters across timestamp ties and page boundaries | Restored `list_preserves_owner_and_tag_filters_across_cursor_ties`, including unfiltered and other-owner pages |
| Nonce expiration boundaries and replay | Maintenance boundary test, HTTP replay tests, and concurrent nonce reservation with exactly one winner; caller-transaction rollback is superseded by independently reserved nonces |
| Publication conflict, deletion, and failed publication commit | Duplicate/independent-router conflict tests, owned downloads after deletion, immediate tag-write rollback, and deferred commit-failure rollback |
| File length mismatch and midstream truncation | SQL size constraints and immutable content checks; reported sizes derive from stored bytes, and fetched response bytes survive concurrent deletion |
| Interrupted writes, cleanup journals, unlink failures, and stale GC candidates | Filesystem-specific states no longer exist; transactional upload rollback and maintenance rollback/recovery cover the applicable failure guarantees |
| Signal cleanup waiting for uploads and shutting down | Internal startup maintenance runs with all upload permits occupied; shutdown waits for a database-blocked active sweep to finish |

Additional migration checks cover invitation rollback and races, pool saturation/reconnection, and timestamp rechecks after awaited nonce insertion. The suite passes nine private database tests and 22 API tests, plus database-free Rust tests. The optional maximum-transfer profile remains separately invoked.
