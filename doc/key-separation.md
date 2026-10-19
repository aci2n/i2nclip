# Purpose and file key separation

## Goal and scope

Replace the shared encryption key with per-file metadata and descriptor keys and
library-wide tag-label and tag-token keys. HKDF-SHA256 uses the identity seed,
salt UTF8("i2nclip"), and these exact UTF8 info strings:

- i2nclip/keys/v1/metadata/FILE_ID (AES-256-GCM)
- i2nclip/keys/v1/descriptor/FILE_ID (AES-256-GCM)
- i2nclip/keys/v1/tag-label (AES-256-GCM)
- i2nclip/keys/v1/tag-token (HMAC-SHA256)

FILE_ID is exactly 64 lowercase hexadecimal characters. Preserve current AAD,
envelope/plaintext versions, normalization, HMAC message, and chunk protocol.
Every envelope encryption generates a fresh random 96-bit nonce internally.

## Interfaces and ownership

LoadedKey holds a non-extractable HKDF handle, signing key, tag-label AES key,
and tag-token HMAC key. Purpose-specific metadata/descriptor operations select
keys and AAD. The internal envelope primitive accepts only an AES key and bytes;
production interfaces have no nonce override. Session ownership and existing
media-item ownership remain unchanged; add no cache, persistence, or store.
Derive non-extractable keys directly with WebCrypto deriveKey. Wipe temporary
seed buffers even on failure and release handles when their owners end. Key
handles cannot be revoked; the session HKDF handle can derive all file keys.

## Persistence, lifecycle, and failures

Only new ciphertext and tag indexes are supported. Do not bump versions, add
fallback readers/migration, or automatically clear databases. Existing identity
and recovery formats still load, but old media and tag indexes are incompatible.
Malformed IDs/envelopes and authentication failures release no plaintext.
Preserve unreadable-item handling and sequential upload failure isolation.
Preserve cancellation and stale-session guards: WebCrypto itself cannot be
cancelled, but stale completion must not publish media, URLs, or upload results.

## Exclusions

No rotation, rollback detection, search completeness proofs, algorithm changes,
server-specific keys, database changes, visual changes, or compatibility work.
Random per-upload content keys, chunks, signing, password envelopes, pairing,
and recovery remain unchanged.

## Acceptance and delivery

Rust reference and JavaScript vectors agree on all four purposes and chunks.
Test file/purpose separation, wrong identity, malformed inputs, tampering,
non-extractability, caller-buffer preservation, fresh metadata edit nonces,
immutable descriptors/content, tag matching/search, and stale completion guards.
Deterministic JS fixtures temporarily mock randomness with automatic cleanup;
never expose fixture controls in production. Independent fixtures use distinct
file IDs or nonces. Remove obsolete whole-file vectors and descriptions.
Run make format-check, make test, make test-build, and make test-e2e using the
Node version from client/.nvmrc. Commit cohesive warning-free changes.
