# Backend improvement priorities

Status: upload receipt removal, strict Ed25519 validation, browser-compatible origin normalization, body-read deadlines, and endpoint-specific byte caps implemented with user approval; remaining changes are proposals. Updated 2026-10-10. The detailed findings and security boundaries are in [backend-review.md](backend-review.md).

## Completed

- Removed upload receipts, their redundant body hashing, and the client's cached-request replay path.
- Duplicate UUID uploads return `409`, including identical payloads. Existing databases drop the obsolete table on startup while preserving media and tags.
- Client upload flows retain source UUIDs across retries. After a lost successful response, users must check the library; retries cannot confirm success.
- Verification passed: `make test` (54 client tests, 18 Rust tests, Svelte checker), `make extension`, and checks on changed-file formatting.
- Strict Ed25519 validation: registration rejects invalid/weak points before spending invitations, and strict request verification rejects legacy weak-key forgeries before reading bodies or persisting nonces. Valid-client headers, signatures, and encrypted formats are preserved; existing key rows remain stored.
- Strict-validation verification passed: `make test` with Node v22.23.3 (54 client tests, 22 Rust tests, and Svelte checks with zero errors/warnings), touched-file Rust formatting, and `git diff --check`.
- Browser-compatible origin normalization: replaced manual host/port normalization with `url::Url` origin serialization and explicit origin-only configuration checks. Shared fixtures compare Rust output with JavaScript URL origins, and API tests verify canonical-origin signatures against every accepted configured origin.
- Origin-normalization verification passed: `make test` with Node v22.23.3 (55 client tests, 24 Rust tests, Svelte checks with zero errors/warnings), `make extension` without warnings, Rust/JavaScript/fixture formatting checks, and `git diff --check`.
- Total body-read deadlines: 120 seconds for uploads, 30 seconds for metadata PUTs, and 10 seconds for media GET/DELETE and registration. Timed-out reads release bodies/partial buffers and return `408`. Paused-clock tests cover trickling, cleanup, per-endpoint deadlines, spent nonces, and preserved invitations. Byte caps and upload admission remain unchanged.
- Deadline verification passed: `make test` with Node v22.23.3 (55 client tests, 27 Rust tests, Svelte checks with zero errors/warnings), `make extension` without warnings, touched-file Rust formatting, and `git diff --check`.
- Endpoint-specific byte caps: GET/DELETE require empty bodies, PUT allows 69,640 bytes, POST retains 33,624,180 bytes, and registration retains 4,096 bytes. Early declared-length checks and streaming reads enforce the same media cap after authentication. Frame decoding and cap calculations share one token-text bound.
- Byte-cap verification passed: `make test` with Node v22.23.3 (55 client tests, 30 Rust tests, Svelte checks with zero errors/warnings), `make extension` without warnings, touched-file Rust formatting, and `git diff --check`. API tests cover exact boundaries, rejection before body polling, and streamed overflow with missing or dishonest Content-Length.

## Proposed order

Priority indicates urgency; order separates changes into independently reviewable steps. P1 findings are medium-severity issues, not demonstrated compromise of normally generated library keys.

| Order | Priority | Change | Result and acceptance criteria |
| --- | --- | --- | --- |
| 1 | P1 — complete | Validate registered Ed25519 points, reject weak keys, and use strict request verification | Invalid/weak registrations return `400` without consuming an invitation; forged requests under legacy weak keys return `401`; valid clients and vectors remain compatible. Implementation scope below. |
| 2 | P1 — complete | Replace manual origin normalization with browser-compatible URL parsing | Uppercase hosts, IDNA, IPv6, and default/nondefault ports serialize consistently with the browser. Invalid ports, credentials, paths beyond an optional root slash, queries, and fragments fail configuration validation. Parser-repaired inputs and collapsed raw paths are also rejected. |
| 3 | P1 — partial | Set endpoint-specific body caps, body-read deadlines, and a bound on concurrent large transfers | Byte caps and total body-read deadlines are implemented. Pending: large transfers have admission control before buffering with permits covering retained buffers. See the request-limit proposal for concrete limits. |
| 4 | P2 | Replace year-long immutable content caching with `no-store` | Delete/recreate of an ID returns current content, and client content fetches bypass previously cached responses. Verify response headers, delete/recreate behavior, and actual browser caching. This avoids permanent UUID tombstones or a new versioned URL format. |
| 5 | P2 | Borrow content and metadata slices during upload frame decoding | Remove large frame-to-content copies while retaining bounds, UTF-8 checks, trailing-byte rejection, and identical wire bytes. Preserve vector and malformed-frame tests. |
| 6 | P2 | Add an index on nonce expiry | Existing databases gain `nonces(expires)` through idempotent schema setup. Keep atomic replay rejection and the same timestamp/expiry rules. Defer scheduled cleanup until measurements justify it. |
| 7 | P2 | Coordinate GC, upload publication, deletion, and download opening | Protect active blobs and avoid ownership-check/read races when IDs are reused. Because GC runs in another process, an in-process mutex alone is insufficient. Propose a small cross-process locking strategy with an explicit lock order, reference rechecks, and deterministic race tests before implementing. |
| 8 | P3 | Separate server verification from reference-client crypto helpers | Make the production server's public-key-only responsibilities clear. Keep shared Rust/JS vectors and avoid creating a framework or changing cryptographic inputs. |
| 9 | P3 | Simplify database parameters and request parsing | Use `rusqlite::types::Value` and `params_from_iter`, reuse the tag query statement, and parse list parameters only on list requests. Preserve ownership filtering, AND search, pagination order, and exact signed request targets. |
| 10 | P3 | Remove redundant error-string matching and trim tutorial comments | Use typed `AlreadyExists` checks. Retain comments about AAD, ownership, replay, limits, and crash ordering. Correct the multipart/signature explanation. |

Storage quotas become P1 before expanding registration to less-trusted users. Propose account limits and total-disk policy then; current per-request limits do not bound persistent storage. Bounded/streamed downloads fit with steps 3 and 7 and require ensuring transfer permits live until the response body completes.

Keep client-generated UUIDs, existing encrypted blob/frame formats, and the signed-request envelope. Defer per-file keys, key rotation, authenticated revisions, a new protocol version, and a database pool until scale or threat requirements justify them. Rollback detection and collection completeness remain explicit security boundaries.

## Implemented change: strict Ed25519 authentication

### Problem and expected behavior

Before this change, registration checked only that the public key was 32 bytes in canonical base64url. Request verification used dalek's ordinary `verify`. A confirmed probe used the encoded Edwards identity point (`01` followed by 31 zero bytes) and signature `R = identity, S = 0` to pass verification for an arbitrary message without a signing secret.

The attack requires that weak key to have been registered using a valid invitation or inserted by an administrator. It does not let an attacker forge signatures for normally generated users. Nevertheless, the server's possession-of-secret requirement should apply to every registered namespace.

Invalid or low-order public keys now cannot be registered, and requests under previously stored weak keys fail strict verification. Normally generated identities continue working with the same headers and signatures. This uses the existing `ed25519-dalek` dependency; see its [weak-key and strict-verification documentation](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.is_weak).

### Implementation scope

1. In `src/auth.rs::parse_public_key`, retain canonical base64url and length checks, construct `ed25519_dalek::VerifyingKey::from_bytes`, and reject `is_weak()`. Map either failure to a fixed `Error::BadRequest("invalid public_key")`. Keep this check before `consume_registration_code`, so rejected registrations do not spend the invitation.
2. In `src/crypto.rs::verify`, replace ordinary verification with `verify_strict`. Continue mapping point parsing, signature parsing, and verification failures to `Unauthorized`. Remove the now-unused `Verifier` trait import if no other call needs it.
3. Keep existing database rows. Strict verification rejects legacy weak keys at request time; no automatic deletion, owner migration, or ciphertext rewrite is needed. If a manually provisioned weak key exists, it will stop authenticating; ordinary generated keys are unaffected.
4. Update [protocol.md](protocol.md), [crypto.md](crypto.md), and the review/roadmap status to describe the implemented checks and compatibility boundary.

No new crate, new endpoint, challenge flow, schema migration, client crypto change, or wire-format version is proposed. This step does not add a registration proof-of-possession exchange or claim full prime-order subgroup validation beyond dalek's documented parsing and strict checks.

### Regression tests

- Public-key parsing rejects the identity point, another known low-order point, and a fixed encoding verified to fail dalek point parsing. Keep malformed/noncanonical base64 coverage.
- Crypto verification rejects `R = identity, S = 0` for a weak key and arbitrary message. Valid generated-key signatures still verify; tampered messages/signatures still fail.
- API registration of a weak/invalid key returns `400`; the same invitation can subsequently register a valid key with `204`.
- Insert a weak key directly into `registered_keys` to represent a legacy database. Submit its forged authenticated request and expect `401`. Use a body that fails if read to verify rejection occurs before payload processing; ensure its nonce was not persisted.
- Retain the existing allow-list, replay, body-hash, origin, ownership, and shared Rust/JavaScript vector tests.

Verification completed: focused library/API tests and `make test` using Node v22.23.3 passed, including all 22 Rust tests, 54 client tests, and shared Rust/JavaScript vectors. The Svelte checker reported zero errors and warnings. Touched-file Rust formatting and `git diff --check` passed. Client runtime and visual behavior did not change in this step, so Firefox visual review was unnecessary.

### Next approval boundary

Strict Ed25519 validation, origin normalization, total body-read deadlines, and endpoint-specific byte caps were approved and implemented. Remaining within order 3: bounded concurrent uploads, as described in the [request-limit proposal](request-limits.md). Download admission and streaming remain a separate follow-up within that priority. Await approval before implementing those remaining changes.
