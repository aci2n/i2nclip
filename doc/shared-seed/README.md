# Shared library seed cutover

Approved implementation contract, 2026-10-21. One permanent Ed25519 seed is the
shared library identity. Generate natively; genesis retains its public key.
HKDF-SHA256 derives the encryption root using salt UTF8("i2nclip") and MessagePack
info ["i2nclip/library-encryption/1", library_id]. Blocks derive separate AES-GCM
keys with fresh public salts and info ["i2nclip/chain/key/1", library_id]. Random
file/object keys remain carried in encrypted references.

Genesis: [1, signing_public_key]. Library ID: existing domain-separated genesis
hash. Initial head: genesis, sequence zero. Record body: [1, library_id, sequence,
previous_hash, storage_effects, block_salt, nonce, ciphertext]. Existing signed
body/signature envelope, signing/hash/AAD domains and bounds remain.
Credential plaintext: [1, server_origin, genesis_bytes, seed,
[trusted_sequence, trusted_hash]]. Only the critical services/library-identity.ts
module may deliberately construct, parse or export seed-bearing plaintext. Its
private class owns seed buffers; callers receive opaque handles, public identity,
non-extractable runtime keys, or sealed credentials. No raw seed getter. Session
and pairing orchestration form its documented production caller allowlist. This
is an audit boundary, not a sandbox against arbitrary same-origin code execution.

Remove device identities, enrollment/revocation, privileged recovery, epochs,
rotation and HPKE. PAKE authenticates and encrypts the five-message credential
transfer. Backups preserve credentials only and use generated strong passwords.
Clients independently verify and materialize history through trusted checkpoints.

The numbered specs are implemented in order, one separate commit each. Direct
consumers/fixtures may move with their owning change to keep commits compiling.
Intermediate commits form an undeployed cutover, not a compatibility release.
Fresh databases use the rewritten 001 baseline. Existing databases must be
explicitly recreated; startup never silently deletes data.

Verification is scoped to affected code. E2E, screenshots, resource profiling,
and targets that invoke them require explicit user approval, even at the end.
The client remains one web app with one unnamed library. No multi-library,
termination, data backup or general framework is included.
