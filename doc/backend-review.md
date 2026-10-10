# Backend review

The historical SQLite/filesystem review is superseded by PostgreSQL storage. Current persistence lives in `src/db.rs`; `src/store.rs` holds shared application state and protocol validation. Handlers contain no SQL, database mutexes, filesystem operations, or blocking-work dispatch.

Uploads atomically insert sealed content, metadata, and tags. Metadata updates lock the authorized row through UPDATE and replace tags in the same transaction. Deletes cascade tags. Lists fetch metadata and sorted tags in one statement without selecting content, deriving size with `octet_length`. Downloads fetch authorized owned bytes in one statement and return connections before response draining.

Registration consumes invitations and registers keys atomically. Authentication verifies signatures, reserves a nonce asynchronously, and rechecks timestamps after insertion completes, before reading bodies. Failed body verification spends the nonce. Maintenance deletes nonces with `expires < now` and invitations with `expires_at <= now` in one transaction.

Body sizes and read deadlines remain bounded. Two uploads and two downloads are admitted per application instance. Async hashes yield every 64 KiB; SQLx encoding/decoding can still copy complete content values. Full-buffer downloads are intentional. Slow response readers can delay shutdown and occupy download slots indefinitely; timeout work remains in [priorities.md](priorities.md). Storage quotas and proxy rate limiting remain deployment concerns.

Crypto framing and client/server vectors are unchanged. Content hashes bind metadata AAD and are checked before client decryption. Encryption detects corruption but does not provide metadata rollback detection or library completeness proofs.
