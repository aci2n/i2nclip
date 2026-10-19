# Backend improvement priorities

This list distinguishes existing behavior from unimplemented follow-ups. Startup applies numbered SQLx migrations; there is no legacy-schema import path.

## Completed

- Concrete async SQLx database layer, bounded eight-connection pool, atomic content/metadata/tag writes, and transactional invitation consumption.
- Random file identifiers, encrypted content-key descriptors, independently authenticated chunks, strict Ed25519 verification, canonical browser origins, shared crypto vectors, owner isolation, AND tag search, and cursor pagination.
- Authentication checks timestamp freshness before database work and after nonce insertion, preventing delayed replays after nonce cleanup.
- Endpoint body caps/deadlines and separate four-upload and sixteen-download admission, plus one upload and two downloads per public key. Downloads use stable, privately cacheable 4 MiB chunks, own only the selected chunk, and release database connections before responses drain.
- Metadata updates compare the prior ciphertext hash under a row lock. Stale edits return the current item without writing; the client loads current tags and preserves the draft for retry.
- Incremental hashing yields between at most 64 KiB chunks. Maintenance runs at startup/hourly without upload permits, retaining inclusive nonce boundaries and atomically deleting expired invitations.
- Device-local “Compress images to WebP” defaults on: JPEG/PNG/BMP uploads retain dimensions and replace originals only when smaller. The preference is excluded from recovery and pairing; see [client ownership](session.md#upload-compression).
- Transfer admission expires after 30 seconds, download resources after 180 seconds even without body polling, and executable shutdown after 30 seconds; see [deadline behavior](transfer-shutdown-proposal.md).
- Create retains one candidate identity in session memory across registration/storage failures. Same-origin retries check signed registration before submitting an invitation. Reload or closure loses pending enrollment.

## Remaining work

1. **P2 — Profile and bound HTTP buffer growth.** Measure chunked uploads, Vec capacity, and SQLx encoding/decoding copies near maximum frame size. The optional maximum-transfer profile records RSS and responsiveness; select a buffering strategy from evidence.
2. **P3 — Tighten small Rust allocation details.** Reject the 65th distinct query tag immediately. State clones already share the origin through `Arc<str>`. Keep flat modules and explicit transaction/resource ownership.
3. **P3 — Measure selective tag searches.** Use representative libraries and query plans before adding token-first indexes.

Per-key storage quotas and transactional usage counters are implemented, defaulting to 512 MiB and 10,000 files. Rollback detection, collection completeness, and key rotation remain separate threat-model decisions. Content keys are already independent per file.

A restarted upload creates a fresh random ID and content key. Identical chunk PUT retries return `204`; conflicting bytes at the same ID/index return `409`. The client best-effort deletes failed reservations while its session remains active.

## Client improvements to specify

- Consider multiple simultaneous pairing sessions for the same registered identity and shared relay storage for multiple server instances.

These are suggestions, not authorized implementation work. Current client ownership is documented in [session.md](session.md); test preparation and isolation are in [test-pipeline.md](test-pipeline.md).
