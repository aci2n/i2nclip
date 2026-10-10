# Backend improvement priorities

PostgreSQL storage supersedes all SQLite connection/mutex, filesystem locking, staged-file journal, signal-driven GC, and secure-delete work. There is no migration or import path.

## Completed

- Concrete async SQLx database layer, bounded eight-connection pool, atomic content/metadata/tag writes, and transactional invitation consumption.
- Content-hash identifiers, strict Ed25519 verification, canonical browser origins, shared crypto vectors, owner isolation, AND tag search, and cursor pagination.
- Authentication rechecks timestamps after awaited nonce insertion, before body reading.
- Endpoint body caps/deadlines and separate two-slot upload/download admission. Downloads own bytes and release database connections before responses drain.
- Incremental hashing yields between at most 64 KiB chunks. Maintenance runs at startup/hourly without upload permits, retaining inclusive nonce boundaries and atomically deleting expired invitations.

## Remaining work

1. **P2 — Bound download duration and shutdown waiting.** Define a response timeout or proxy idle policy, including responses that are never polled. Verify permit release and graceful shutdown.
2. **P2 — Profile and bound HTTP buffer growth.** Measure chunked uploads, Vec capacity, and SQLx encoding/decoding copies near maximum frame size. The optional maximum-transfer profile records RSS and responsiveness; select a buffering strategy from evidence.
3. **P3 — Tighten small Rust ownership/allocation details.** Reject the 33rd distinct tag immediately and avoid copying origin strings when cloning state. Keep flat modules and explicit transaction/resource ownership.
4. **P3 — Measure selective tag searches.** Use representative libraries and query plans before adding token-first indexes.

Storage quotas remain necessary before expanding invitations to less-trusted users. Rollback detection, collection completeness, key rotation, and per-file keys remain separate threat-model decisions.

Re-encrypting a failed client upload creates fresh ciphertext and normally a new hash. An exact sealed-byte retry returns `409`; refresh the library after a lost response before retrying.

## Local verification

`make test`, `make extension`, and `make lint` pass under Node 22.23.3. PostgreSQL 18 verification passed three database tests and 23 API tests; all 69 Firefox E2E tests passed against isolated PostgreSQL databases. The testcontainers runner supports an opt-in host-network fallback when Podman's default network cannot use `/dev/net/tun`, binding only a random loopback port. An opt-in full container restart check confirmed that an existing SQLx pool reconnects and stored bytes survive.

The in-process maximum-transfer profile passed two concurrent 32 MiB uploads followed by two concurrent downloads: 4.697 seconds transfer time, 32.671 ms worst additional timer delay, 305,532 KiB peak RSS, and 1,469,032 bytes allocated by the inspecting PostgreSQL backend. Those RSS figures include fixture/client allocations. A separate-process release profile now measures 234–284 MiB server peak RSS across two local runs, including ordinary/chunked uploads and held downloads. PostgreSQL process sampling and accounting limits are recorded in [postgresql-profile.md](postgresql-profile.md). Held responses had no idle transactions. Allocation-level buffer attribution and a hard memory bound remain outstanding.

The i2nfra templates pass strict Jinja rendering and local Quadlet generation. Python checks and shell syntax pass. Remote deployment dry-run is blocked by missing SSH known-hosts setup in the execution environment; production Quadlet/container validation remains outstanding. Local testcontainers validation now passes with API access and the host-network fallback. No VPS deployment was performed.
