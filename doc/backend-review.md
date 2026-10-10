# Backend review — 2026-10-10

Scope: all eight `src/*.rs` files, `sql/001_init.sql`, backend integration tests, and the matching current client protocol/API implementation. The initial review made no runtime changes. Upload receipts and their client replay path were subsequently removed, and strict Ed25519 validation and browser-compatible origin normalization were implemented with user approval. Related recommendations below reflect those changes. Other priorities distinguish confirmed defects from hardening recommendations and intentional security boundaries. Source line references reflect the initial review and may shift as code changes.

## Findings

### 1. Fixed: weak registered Ed25519 keys allowed signatures without a secret

Locations: `src/auth.rs` (`parse_public_key`), `src/crypto.rs` (`verify`). At review time, registration validated canonical base64 and length, but did not validate the curve point or reject low-order keys. Request verification used `Verifier::verify`.

A temporary Rust probe confirmed the encoded Edwards identity point (`01` followed by 31 zero bytes), with signature `R = identity, S = 0`, passes the exported verifier for an arbitrary message; `verify_strict` rejects it. If such a key is registered using a valid invitation, possession of a signing secret is no longer required to access that namespace. This does not forge requests for normally generated user keys and does not bypass the invitation requirement.

Implemented: registration parses a `VerifyingKey` and rejects `is_weak()` before consuming an invitation; requests use `verify_strict`. Regression tests cover weak/invalid points, preserved invitations, and forged requests under legacy stored weak keys rejected before reading the body or persisting a nonce. Existing rows and the wire format remain unchanged. The distinction is documented by [ed25519-dalek 2.2.0](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.is_weak).

### 2. Fixed: origin normalization disagreed with the browser

Location: `src/lib.rs` (`normalize_origin`). At review time it manually stripped scheme/slashes/default ports, preserving uppercase hostnames and accepting invalid authorities. A probe confirmed `https://EXAMPLE.com:443` produced `https://EXAMPLE.com`, while `https://example.com:invalid` was accepted. The browser lowercases the host and rejects the invalid port. Valid deployment configuration using an uppercase hostname therefore made every normal client's signature fail. Unicode hostnames and credentials were other cases the parser did not normalize/reject consistently.

Implemented: `url::Url` parsing and origin serialization, explicit HTTP(S)/host/component validation, and small raw-input checks to reject parser repairs and collapsed non-root paths. Shared `client/tests/origin-vectors.json` cases verify Rust outputs against JavaScript's `new URL(input.trim()).origin`, including uppercase hosts, IDNA, IPv6, and ports. API tests authenticate browser-canonical signed requests against every accepted configured origin. This fixes deployment correctness rather than a demonstrated cross-origin authentication bypass.

### 3. Medium: per-request caps do not bound total resource use

Locations: `src/routes.rs:65-142` (`Authed`, body reader), `src/frame.rs:90-94`, `src/store.rs:232-276`, `src/store.rs:367-379`.

Every authenticated method may buffer the full approximately 32 MiB POST limit. A signed GET or DELETE with a large correctly hashed body reaches a handler that ignores those bytes. Upload decoding copies the content out of the buffered frame; additional requests and blocking jobs can retain many such buffers concurrently. Downloads read whole files into memory without a read cap. There are no server concurrency limits, account quotas, or total storage caps. At review time there were also no body-read deadlines, allowing even small registration bodies to be held open indefinitely. A registered abusive client can exhaust memory, disk, or workers. The README correctly delegates rate limiting to the proxy, but request rate alone does not cap concurrent buffers or stored data.

Partially implemented: complete body reads now have 120/30/10-second deadlines for media POST/PUT/GET-or-DELETE, respectively, and registration has a 10-second deadline. Trickling cannot reset them; timeout releases the body and partial buffer and returns `408`. Remaining recommendations: use endpoint-specific body limits (empty GET/DELETE, smaller PUT), cap concurrent large transfers before buffering, and enforce storage quotas if invitations are not a sufficient trust boundary. Borrow frame slices rather than copying content; stream file responses with a stored-size check. Retain signature verification before body reads and streaming byte caps.

### 4. Medium: year-long immutable caching conflicts with UUID reuse

Locations: `src/routes.rs:316-333`, `src/store.rs` (`remove`), `sql/001_init.sql` (`files`). The server describes content as immutable and allows private caching for one year, but deleting an item removes all persistent evidence of its UUID. The same owner can then upload different content with that UUID. A fresh request can reuse a browser's cached old response (subject to cache behavior), and the old ciphertext still authenticates under the same key and AAD. The API accepts caller-selected IDs even though the UI normally generates fresh UUIDs.

Recommendation: either enforce permanent non-reuse, use a content generation/hash in the URL, or stop promising immutable caching across deletion/recreation. Add a delete/recreate test and a real HTTP cache test. This issue was identified from control flow; browser cache reuse was not reproduced during this review.

### 5. Low: replay cleanup scans the entire nonce table on each request

Locations: `src/store.rs:207-229`, `sql/001_init.sql` (`nonces`). Every successfully authenticated request deletes expired nonces by `expires`, but the only nonce index is the primary key on `nonce`. The expiry delete requires scanning all retained rows while holding the single database mutex. A future timestamp retains a nonce for almost ten minutes, increasing that work. This is a throughput concern, not a replay bypass.

Recommendation: index `nonces(expires)` and consider periodic/batched cleanup if measured traffic justifies it. Keep nonce insertion atomic and persistent. Globally unique random nonces are sufficient for the current client; owner-scoping is optional and does not justify a protocol rewrite by itself.

## Security boundaries and design tradeoffs

- **No rollback detection:** A malicious server can replay prior valid metadata for the same ID, omit list items, or change the tag index. GCM protects each blob, not freshness or collection integrity. Document this boundary; add authenticated revisions only if malicious-server rollback resistance is a requirement.
- **Random GCM nonce lifetime:** One encryption key covers all content and metadata in every restored client. There is no usage cap or key rotation. This is appropriate at ordinary personal-library scale, but not an unlimited-use guarantee. Explicit-nonce test APIs should be isolated or clearly marked. See [crypto.md](crypto.md) for limits and exact inputs.
- **Storage is not one transaction:** Upload writes a blob before inserting a row, and deletion commits before unlinking. Crashes can leave orphans and block retries with `409` until cleanup. GC's snapshot plus age guard is a heuristic: `--min-age 0` can race an in-flight upload, and a sufficiently delayed scan/write can defeat a positive guard. If stronger crash/concurrency guarantees are required, coordinate GC and publication with a shared lock and recheck references before unlinking. Do not claim the current one-hour guard is a proof of safety.
- **Download ownership check and filesystem read are separate:** Concurrent deletion/recreation of the same ID can change which ciphertext is read after ownership was checked. Wrong-owner ciphertext will not decrypt with the original owner's key, but avoid this race if ciphertext access isolation matters by opening the file while the protected row is current and coordinating ID reuse.
- **Local data directory is trusted:** UUID validation prevents request path traversal; owner-only directories and exclusive file creation are good. Reads assume files on disk are legitimate, and do not defend against privileged filesystem mutation or oversized replacement blobs.
- **Registration retry behavior:** A lost successful registration response leaves the code consumed; resending it fails even for the same key. That matches single-use codes but is not fully idempotent registration. Explain it in client/admin recovery workflows rather than casually calling the endpoint idempotent.

## Is the custom protocol minimal?

It is close to minimal for the chosen requirements: a public-key allow-list, no server decryption key, stateless request signing, replay prevention, binary uploads, encrypted metadata/previews, and searchable tags. The frame parser is short, bounded, and rejects trailing bytes. HTTP supplies routing/statuses and JSON supplies list serialization. The cryptographic primitives are standard library implementations.

The protocol is not literally the fewest possible bytes. POST's fixed-width UUID could omit its length prefix; a final field could consume the remaining body; 32-byte binary tag tokens would be smaller than newline-separated base64url. Those changes save tens or hundreds of bytes beside a potentially 32 MiB file, require coordinated migration, and make the format less uniform. Keep the current frames unless actual measurements justify a v2.

The authentication envelope is the main custom security surface. Its fields have clear purposes: origin prevents cross-deployment reuse, method/target prevent rerouting, body hash commits the payload before reads, timestamp bounds replay storage, nonce prevents repeated execution, and public key selects the owner. Removing those fields weakens current guarantees. Calling the envelope `Bearer` is unconventional because it is proof-of-possession, but changing the scheme alone adds migration work without fixing a security defect.

Simpler alternatives change requirements: a random bearer credential is easy to verify but gives the server a reusable impersonation secret; a challenge flow adds a round trip and state; standardized HTTP Message Signatures offer interoperability but add parsing/canonicalization scope. Choose those only for a concrete operational or interoperability reason.

The comment in `src/frame.rs` overstates multipart's difficulty: multipart can carry binary data and can be signed over its serialized bytes. It needs boundary selection/parsing, but is not inherently incompatible with signatures. The existing frame remains a reasonable smaller implementation.

## Simplifications without changing the wire format

1. Separate server-used verification/hash/blob checks from reference-client encryption, tag derivation, identity generation, and encoders. The production server never needs a seed or decryption key, yet `pub mod crypto` exposes all of them and brings client-reference dependencies into the server crate. A small verification module plus a reference/test helper library would make that boundary clearer. Preserve shared vectors.
2. Return borrowed metadata/content slices from frame decoding. This removes a large copy and simplifies ownership; let the storage workflow own the original body buffer.
3. Completed by receipt removal: storage no longer hashes upload bodies again for receipt insertion or retry lookup. Authentication still verifies the signed body hash.
4. Replace `Vec<Box<dyn ToSql>>` plus the derived reference vector in listing with `Vec<rusqlite::types::Value>` and `params_from_iter`. Dynamic placeholders remain necessary for variable tag counts; boxing does not.
5. Reuse the token query statement across page rows. Returning tokens may also be unnecessary because clients already decrypt readable tags; check public API consumers before removing fields. There is no need for a complex batch-query layer for a fixed 24-item page.
6. Parse list query parameters only for the list endpoint. Currently unrelated media methods can fail because a shared extractor parses an irrelevant `after` parameter. Preserve raw request-target signing regardless of query parsing.
7. Remove the string-based `"File exists"` check in `add`; the typed `ErrorKind::AlreadyExists` check already handles it. Retain file-write cleanup and synchronization.
8. Keep comments explaining invariants (AAD, ownership, replay expiry, crash ordering), and trim repeated Java/Python analogies and Rust syntax tutorials. They make security-relevant control flow harder to scan.

The single SQLite connection and explicit blocking pool are reasonable for this scale. A connection pool, generic repository layer, custom transaction framework, resumable chunks, or a new envelope library would add complexity without an established requirement. Upload receipts were intentionally removed: all duplicate UUIDs now conflict, and a retry cannot confirm an upload whose successful response was lost.

## Verification and limitations

- Initial review: `cargo test` passed 9 unit tests and 8 API integration tests, including shared Rust/JS vector equality. After receipt removal, the first backend run passed 9 unit tests and 9 API integration tests.
- Initial review: 11 focused Node tests passed under Node v26.11.1. Receipt-removal verification uses the specified Node v22.23.3 after `npm ci --prefix client`: all 54 client tests pass and the Svelte checker reports zero errors and warnings.
- Final receipt-removal verification: `make test` passed all 54 client tests, Svelte checks, and 18 Rust tests. `make extension` built and packaged successfully without warnings. Formatting/lint checks passed for the six changed JavaScript files, and `git diff --check` passed.
- Strict Ed25519 validation verification: `make test` under Node v22.23.3 passed 54 client tests and 22 Rust tests, including the new regression tests and shared vectors. The Svelte checker reported zero errors/warnings; touched-file Rust formatting and `git diff --check` passed.
- Origin-normalization verification: `make test` under Node v22.23.3 passed 55 client tests and 24 Rust tests, including shared URL fixtures and authenticated API requests for every accepted origin. Svelte checks and `make extension` completed without warnings. Touched-file Rust/JavaScript/fixture formatting and `git diff --check` passed.
- Body-deadline verification: `make test` under Node v22.23.3 passed 55 client tests and 27 Rust tests. Paused-clock tests cover timeout timing, trickling, disposal, endpoint deadlines, spent nonces, and preserved registration invitations. Svelte checks and `make extension` completed without warnings; touched-file Rust formatting and `git diff --check` passed.
- A temporary Rust probe confirmed weak-key signature acceptance, strict-verifier rejection, uppercase-host preservation, and invalid-port acceptance. The probe was removed after execution.
- Storage/cache concurrency findings are source-derived; no live Firefox cache, load, crash, or race reproduction was performed. Existing tests cover ordinary ownership, replay, body tampering, encryption/AAD tampering, registration, and GC basics, but do not cover the findings above. Receipt-removal tests additionally cover duplicate conflicts, unchanged content, and migration from a legacy receipt table.
- This was not a dependency advisory audit, penetration test, or formal proof. Changes following the review cover receipt removal, associated client retry behavior, strict Ed25519 validation, origin normalization, body-read deadlines, tests, and documentation; unrelated existing frontend work is preserved.
