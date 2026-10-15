# Backend improvement priorities

This list distinguishes existing behavior from unimplemented follow-ups. The current schema is initialized directly; there is no migration or import path.

## Completed

- Concrete async SQLx database layer, bounded eight-connection pool, atomic content/metadata/tag writes, and transactional invitation consumption.
- Content-hash identifiers, strict Ed25519 verification, canonical browser origins, shared crypto vectors, owner isolation, AND tag search, and cursor pagination.
- Authentication checks timestamp freshness before database work and after nonce insertion, preventing delayed replays after nonce cleanup.
- Endpoint body caps/deadlines and separate four-upload and sixteen-download admission, plus one upload and two downloads per public key. Downloads own bytes and release database connections before responses drain.
- Metadata updates compare the prior ciphertext hash under a row lock. Stale edits return the current item without writing; the client loads current tags and preserves the draft for retry.
- Incremental hashing yields between at most 64 KiB chunks. Maintenance runs at startup/hourly without upload permits, retaining inclusive nonce boundaries and atomically deleting expired invitations.

## Remaining work

1. **P2 — Bound download duration and shutdown waiting.** Implement the [proposed transfer and shutdown deadlines](transfer-shutdown-proposal.md), including resource release for responses that are never polled. This remains proposed work.
2. **P2 — Profile and bound HTTP buffer growth.** Measure chunked uploads, Vec capacity, and SQLx encoding/decoding copies near maximum frame size. The optional maximum-transfer profile records RSS and responsiveness; select a buffering strategy from evidence.
3. **P3 — Tighten small Rust allocation details.** Reject the 33rd distinct tag immediately. State clones already share the origin through `Arc<str>`. Keep flat modules and explicit transaction/resource ownership.
4. **P3 — Measure selective tag searches.** Use representative libraries and query plans before adding token-first indexes.

Per-key storage quotas and transactional usage counters are implemented, defaulting to 512 MiB and 10,000 files. Rollback detection, collection completeness, key rotation, and per-file keys remain separate threat-model decisions.

Re-encrypting a failed client upload creates fresh ciphertext and normally a new hash. An exact sealed-byte retry returns `409`; refresh the library after a lost response before retrying.

## Client improvements to specify

- Specify registration uncertainty handling: retain a candidate identity in memory across lost replies or local storage failures and retry the same identity after a signed registration check.
- Assess image compression before upload, including supported formats, quality controls, and whether a setting is warranted.
- Consider multiple simultaneous pairing sessions for the same registered identity and shared relay storage for multiple server instances.

These are suggestions, not authorized implementation work. Current client ownership is documented in [session.md](session.md); test preparation and isolation are in [test-pipeline.md](test-pipeline.md).
