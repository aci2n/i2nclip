# Signed key registration

## Goal and scope

Require proof of possession at POST /api/register-key using the existing Ed25519
Authorization envelope. Keep the MessagePack body {otc, public_key}, algorithms,
origin/method/target/body-hash binding, timestamp window, replay protection and
HTTP limits unchanged. No challenge endpoint, dependency, schema migration,
compatibility fallback or new rate-limit policy.

## Interfaces and ownership

The client registration API receives its loaded crypto key, signs the exact body,
and derives public_key from that key. The session passes its newly loaded key.
The server shares request authentication with explicit Registered/Registering key
policies. Only registration skips the registered-key lookup. Both policies verify
the strict signature and reserve the nonce before reading any body. Registration
checks the signed body hash, validates its public key, and requires equality with
the signing key before consuming the invitation.

## Persistence, lifecycle and failure

Existing nonce expiry/maintenance and cancellation/deadline behavior apply.
Successfully authenticated headers spend their nonce even when reading, decoding,
key matching or invitation validation fails. Bad/missing signatures, wrong origin,
stale timestamps and replays return 401 (early data remains 425). Malformed bodies
or invalid payload keys return 400; a valid but mismatched payload key returns
401. Failed verification never consumes an invitation or creates a key/quota.
Invitation consumption and key/quota insertion remain one database transaction;
re-registration still requires a fresh invitation and signature. No automatic
retry, registration bypass for other routes or reset/deployment is introduced.

## Acceptance

Test registration of an unregistered signer, exact body/signature binding, missing
and forged signatures rejected before body reads, wrong origin/path/timestamp,
header/body key mismatch, replay, weak keys, unchanged invitation after failures,
atomic invitation races, size/deadline policies, and ordinary registered-only
routes. Verify client signatures independently and real browser creation/restore
flows. Run focused checks, isolated PostgreSQL tests, lint and browser tests.
