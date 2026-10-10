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
- The initial schema includes `nonces(expires)` and the pagination index `(owner, created_at DESC, id ASC)`. Typed file-exists handling replaces error-string matching.

## Remaining order

| Order | Priority | Change | Acceptance criteria |
| --- | --- | --- | --- |
| 8 | P3 | Separate server verification from reference-client crypto helpers | Make public-key-only server responsibilities clear. Preserve shared Rust/JS vectors without adding a framework. |
| 9 | P3 | Simplify database parameters and request parsing | Use `rusqlite::types::Value` and `params_from_iter`, reuse tag statements (list-only query parsing is completed). Preserve ownership, AND search, pagination, and signed targets. |
| 10 | P3 | Trim tutorial comments | Retain explanations of AAD, ownership, replay, limits, lock order, and crash ordering. |

Storage quotas become P1 before expanding registration to less-trusted users. Current transfer limits do not cap persistent storage. Rollback detection for metadata, collection completeness, key rotation, and per-file keys remain separate threat-model decisions.

## Next approval boundary

Next proposed change: separate public-key-only server verification from reference-client crypto helpers while preserving shared Rust/JavaScript vectors. Do not implement additional priorities without approval.

Re-encrypting a failed client upload creates fresh ciphertext and normally a new hash. An exact sealed-byte retry returns `409`; after a lost successful response, refresh the library before retrying to avoid creating another entry. No cached replay body or nonce reuse is introduced.

## Verification

The content-hash implementation passed under Node v22.23.3: `make test` (57 client tests, 38 Rust tests, Svelte checker with zero errors/warnings), all 69 Firefox E2E tests, `make extension`, touched-file Biome checks, Rust formatting, and `git diff --check`. Storage fault tests were also rerun after final staging-ownership cleanup.

The subsequent per-hash lock change passed `make test` (57 client tests, 39 Rust tests, Svelte checker with zero errors/warnings), `make extension`, Rust formatting, and `git diff --check`. Lock tests cover independent hashes, contention between separately opened descriptors, persistent lock files, and GC waiting for publication before checking current references. Firefox E2E was not rerun for this backend locking change.

The staged-journal rewrite passed 57 client tests, the Svelte checker with zero errors/warnings, and 40 Rust tests (including SIGUSR1 delivery, upload coordination, interrupted writes/deletes, and commit-failure cleanup). `make extension`, Rust formatting, and `git diff --check` passed. Clippy was unavailable in the installed Rust toolchain. Crash tests inject transaction failures and model interruption states; they do not simulate hardware power loss.

Borrowed frame decoding passed `make test` (57 client tests, 42 Rust tests, Svelte checker with zero errors/warnings), `make extension`, Rust formatting, and `git diff --check`. The allocation regression test measures zero decoder allocations without tags and 2,816 total bytes with 32 tags, independent of content size; the previous copy pattern's positive control allocates 33,620,032 bytes. See [request-limits.md](request-limits.md#decoder-allocation-regression-test) for scope and reproduction.
