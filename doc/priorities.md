# Backend improvement priorities

Current storage supersedes the historical file-lock verification below: uploads and deletions use a durable staged-file journal, and SIGUSR1 runs GC in the single server process. See [gc.md](gc.md).


Status: strict Ed25519 validation, browser-compatible origins, endpoint body caps/deadlines, upload/download admission, bounded download streaming, content-hash identifiers, and coordinated blob publication implemented. The project is greenfield: update the initial schema and protocol directly, retaining current version labels. No legacy migration is required.

## Completed

- Upload receipts and cached-request replay were removed. Exact duplicate sealed-content hashes now return `409` globally, including across owners.
- Registration rejects invalid/weak Ed25519 points before spending invitations; strict verification rejects forged requests before body reading or nonce insertion.
- Origin parsing matches browser URL origins, with shared fixtures and authenticated API coverage.
- Total body-read deadlines: POST 120 seconds, PUT 30 seconds, media GET/DELETE and registration 10 seconds. GET/DELETE have empty bodies; POST is capped at 33,624,140 bytes, PUT at 69,640, registration at 4,096.
- Uploads and downloads each have two admission slots per router. Permits survive blocking work and response lifetime as appropriate.
- Download files are size-validated and streamed in at most 64 KiB chunks. Cancellation, completion, and errors release response capacity.
- Media handlers own body limits, deadlines, and admission; only list parses search parameters. The extractor authenticates headers and retains the unread body.
- Frame decoders borrow content and metadata from the request buffer. Blocking workers retain that buffer and its permit; only response metadata gets an owned copy.
- Flat `src/`: `media.rs` owns media routes and `MediaRequest`; `routes.rs` assembles the router and provides health/registration and shared helpers.
- UUIDs are removed. SHA-256 of complete sealed content is the identifier, blob filename, and content URL. Metadata AAD binds its ciphertext to this hash; clients verify downloaded hashes before decrypting. Immutable content caching remains valid; metadata/list responses stay `no-store`.
- Publication and deletion use the durable `staged_files(id, created_at)` journal, without file locks. SIGUSR1 triggers GC in the running server; it pauses uploads and cleans intents older than seven days. See [gc.md](gc.md).
- Server crypto is limited to verification, hashing, and sealed-blob checks. Reference-client seed handling, encryption, derivation, and signing live in test-only `src/reference_crypto.rs`; client-only dependencies are dev dependencies. Shared vectors are preserved.
- List queries bind `Vec<rusqlite::types::Value>` with `params_from_iter` and reuse one tag statement per request. Owner filtering, AND searches, and cursor ordering are covered together in regression tests.
- Tutorial language comparisons and basic Rust explanations were removed; protocol, AAD, ownership, replay, admission, and crash-ordering comments remain.
- The initial schema includes `nonces(expires)` and the pagination index `(owner, created_at DESC, id ASC)`. Typed file-exists handling replaces error-string matching.

## Remaining work

The earlier simplification list is complete. The new server audit work proceeds one change at a time in this order. Reader connection pooling and a dedicated writer architecture are deferred.

1. **P1 — Recheck authentication timestamps when reserving nonces. Completed.** Acquire the SQLite writer transaction before sampling the clock, reject timestamps outside the accepted window, then reserve the new nonce. Expired nonces are removed by signal-triggered GC, with its own current-time cutoff. This prevents queued copies from deleting an expired replay marker and accepting the same request again. Keep the early authentication check as a cheap rejection. Test expired queued requests, future timestamps, and fresh-request replay.
2. **P1 — Bound blocking database work.** Add admission before spawning authentication/database work so requests cannot fill the blocking pool with mutex waiters. Retain admission through running work even if its HTTP waiter is cancelled; define a bounded wait or busy response. Keep the single connection and existing filesystem coordination. Verify saturation, cancellation, and interaction with transfer permits and GC.
3. **P2 — Bound download duration and shutdown waiting.** Define a response timeout or host proxy idle policy so slow readers cannot indefinitely occupy both download slots. Account for responses that are not polled; timing file reads alone is insufficient. Verify permit release and graceful shutdown behavior.
4. **P2 — Profile and bound HTTP buffer growth.** Measure realistic chunked uploads, including Vec capacity and peak allocation near the maximum frame size. Decoder allocation tests do not cover HTTP buffering. Choose a bounded growth strategy based on results without reserving the maximum for small requests.
5. **P3 — Reuse SQL statements.** Prepare token insertion once per transaction and cache stable lookup/authentication statements. Preserve parameter binding and transactional behavior; measure before more elaborate query changes.
6. **P3 — Batch GC candidates.** Bound the candidate vector and process large backlogs in batches. Advance past failed candidates so a retained intent cannot cause an endless loop. Preserve cleanup intents and filesystem durability ordering.
7. **P3 — Tighten small Rust ownership/allocation details.** Reject the 33rd distinct tag immediately, use checked mutable-connection transactions for metadata updates, and avoid copying the origin on every AppState clone. Prefer explicit `{ ... }` scopes over `drop(conn)` or similar manual drops when the scope makes the connection/lock lifetime clearer. Retain explicit `drop()` where it communicates intentional resource-release ordering or a scope would obscure ownership. Use imports consistently: import modules such as `store` and call `store::...` rather than repeating `crate::store::...` inline, unless qualification resolves ambiguity. Replace staged-file reservation’s `ON CONFLICT (id) DO NOTHING` plus affected-row check with a plain `INSERT`, mapping only `SQLITE_CONSTRAINT_PRIMARYKEY` to `Error::Conflict` and propagating other database errors. Keep bounded token vectors and the flat source layout.
8. **P3 — Measure selective tag searches.** Use representative large libraries and query plans to decide whether a token-first index/query helps rare-tag searches. Add an index only if evidence justifies its write/storage cost.
9. **P3 — Correct secure_delete documentation.** Describe database-page hygiene without promising erasure from WAL history, backups, or storage snapshots.

Storage quotas remain necessary before expanding registration to less-trusted users. Rollback detection, collection completeness, key rotation, and per-file keys remain separate threat-model decisions.

Re-encrypting a failed client upload creates fresh ciphertext and normally a new hash. An exact sealed-byte retry returns `409`; after a lost successful response, refresh the library before retrying to avoid creating another entry. No cached replay body or nonce reuse is introduced.

## Verification

The content-hash implementation passed under Node v22.23.3: `make test` (57 client tests, 38 Rust tests, Svelte checker with zero errors/warnings), all 69 Firefox E2E tests, `make extension`, touched-file Biome checks, Rust formatting, and `git diff --check`. Storage fault tests were also rerun after final staging-ownership cleanup.

The subsequent per-hash lock change passed `make test` (57 client tests, 39 Rust tests, Svelte checker with zero errors/warnings), `make extension`, Rust formatting, and `git diff --check`. Lock tests cover independent hashes, contention between separately opened descriptors, persistent lock files, and GC waiting for publication before checking current references. Firefox E2E was not rerun for this backend locking change.

The staged-journal rewrite passed 57 client tests, the Svelte checker with zero errors/warnings, and 40 Rust tests (including SIGUSR1 delivery, upload coordination, interrupted writes/deletes, and commit-failure cleanup). `make extension`, Rust formatting, and `git diff --check` passed. Clippy was unavailable in the installed Rust toolchain. Crash tests inject transaction failures and model interruption states; they do not simulate hardware power loss.

Borrowed frame decoding passed `make test` (57 client tests, 42 Rust tests, Svelte checker with zero errors/warnings), `make extension`, Rust formatting, and `git diff --check`. The allocation regression test measures zero decoder allocations without tags and 2,816 total bytes with 32 tags, independent of content size; the previous copy pattern's positive control allocates 33,620,032 bytes. See [request-limits.md](request-limits.md#decoder-allocation-regression-test) for scope and reproduction.

The server/reference crypto split passed `make test` (57 client tests, 42 Rust tests, Svelte checker with zero errors/warnings), `cargo check --lib --bins`, `make extension`, Rust formatting, and `git diff --check`. Shared vectors remain unchanged. The production dependency graph excludes AES-GCM, HKDF, HMAC, and Unicode normalization; only test targets compile `reference_crypto.rs`.

SQL parameter/statement cleanup and comment trimming passed `make test` (57 client tests, 43 Rust tests, Svelte checker with zero errors/warnings), `make extension`, Rust formatting, and `git diff --check`. The added list regression covers owner isolation, AND tag filters, reused tag results, filtered/unfiltered pagination, and cursor ties across equal timestamps.

The timestamp recheck passed `make test` (57 client tests, 44 Rust tests, zero Svelte errors/warnings), `make extension`, `cargo fmt --check`, and `git diff --check`. Timestamp tests cover expiration across the inclusive clock boundary without waiting for wall-clock expiration. Authentication owns the writer transaction and second timestamp check; storage only inserts the nonce.

Authentication transaction ownership and GC nonce cleanup passed `make test` (57 client tests, 46 Rust tests, zero Svelte errors/warnings), `make extension`, `cargo fmt --check`, and `git diff --check`. Tests cover timestamp boundaries, nonce transaction rollback/replay, and GC expiration boundaries.
