# Library keys, recovery, and epoch rotation

This is the current cryptographic and credential specification. It supersedes
older revoke-all reset descriptions in the chain design. Detailed implementation
plans are in [device-preserving rotation](device-preserving-rotation.md) and
[canonical genesis and enrollment](genesis-and-recovery-enrollment.md). Formats
are greenfield; no compatibility readers or old-database conversion are supported.

## Keys and authority

The **recovery key** is an offline credential with two independently generated
secrets: an Ed25519 signing seed/public-key pair and a random 32-byte epoch
derivation secret. Neither secret is derived from the other. Generate and load
Ed25519 using native WebCrypto, including a signing probe to validate seed/public
correspondence and non-extractable runtime private handles. No Ed25519 package is
needed. Recovery authority is immutable and never an enrolled device.

Each device generates independent Ed25519 signing and X25519 encryption keypairs.
The signing public key is its identity and HTTP principal. The encryption public
key receives epoch envelopes. Both are bound by enrollment; private device keys
stay in protected local storage and have no backup/export/import format. Lost
credentials require pairing a fresh device, or restoring the recovery file when
no usable peer remains. Do not convert signing keys into encryption keys.

Devices have equal file, purge, enrollment, and revocation authority. Device-signed
revocation requires another authorized device to survive. The recovery key may
sign enrollment, revocation (including the last device), and rotation, but no
ordinary data operations. Only recovery may sign rotation. Any active device may
relay an already recovery-signed authority record; this does not grant it recovery
signing authority. Revoked device identities and encryption keys cannot be reused.
At most 128 devices are simultaneously authorized; revoked devices do not count.

## Genesis and registration

Canonical genesis is MessagePack `[1, recovery_signing_public_key, epoch_1_salt]`.
Both binary fields are exactly 32 bytes. Validate canonical encoding and the
recovery public key; cap encoded genesis at 128 bytes. Library ID and sequence-zero
head are SHA-256 of `UTF8("i2nclip/chain/genesis/1\n") || genesis_bytes`.
Genesis fixes epoch 1 and recovery authority, with no device membership.

Block 1 is recovery-signed `enroll` with effects
`[device_signing_public_key, device_encryption_public_key]`. It uses epoch 1,
sequence 1, genesis as parent, and null ordinary encryption fields. No other
operation or signer may bootstrap the chain. Enrollment at later positions has
this same format and may be signed by recovery or a currently authorized device.

`POST /api/register-key` takes `[invitation_code, genesis_bytes,
signed_first_enrollment_bytes]`, with HTTP proof from the enrolled device. Validate
all bytes, signatures, and identity binding before invitation consumption. In one
transaction consume the invitation and store canonical genesis, the immutable
recovery principal, enrollment block 1, device membership at sequence 1, initial
head, and quota. Exact retries recognize the same first record even after device
revocation, but never reauthorize a revoked key. Different bootstraps conflict.

`libraries` stores immutable genesis bytes instead of decomposed genesis columns.
The database checks its domain-separated hash against `id`. `library_keys` is the
queryable authority/membership projection: one immutable non-revocable recovery
row at sequence 0, plus device signing/encryption bindings and authorization/
revocation sequences. Recovery rows have no device encryption public key. A unique
partial index enforces at most one recovery row per library; atomic registration
inserts exactly one matching genesis. Clients establish authority from genesis,
not from the server's projection.

## Epoch keys and envelopes

For epoch `e`, derive its 32-byte key with HKDF-SHA256:

- IKM: the recovery credential's epoch derivation secret.
- Salt: that epoch's fresh public random 32-byte salt.
- Info: MessagePack `["i2nclip/epoch-key/1", library_id, e]`.

Epoch 1's salt is in genesis. Rotation effects are
`[next_epoch, next_epoch_salt, envelopes]`, where each envelope is
`[device_signing_public_key, hpke_encapsulation, ciphertext]`. Rotation uses the old
epoch in its header, advances by exactly one, is recovery-signed, and has null
ordinary encryption fields. It changes no membership or file state. Revoke devices
before preparing rotation to exclude them. Recipients must equal the complete
membership authorized at the parent, sorted by signing-public-key bytes. Reject
missing, extra, revoked, duplicate, unsorted, or over-limit recipients. Empty
membership permits an empty list. Keep the existing 64 KiB record bound.

Use RFC 9180 HPKE base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM
(suite IDs `0x0020`, `0x0001`, `0x0002`). Each independently sealed envelope contains
only the same 32-byte next epoch key; encapsulation is 32 bytes and ciphertext is
48 bytes. Bind canonical MessagePack info `["i2nclip/epoch-envelope/1", library_id]`
and AAD `["i2nclip/epoch-envelope-context/1", library_id, sequence, parent_hash,
old_epoch, next_epoch, next_epoch_salt, recipient_signing_public_key,
recipient_encryption_public_key]`. The root signature authenticates the entire
transition and every envelope. The outer record is readable without any epoch key.

The pinned `hpke` package uses native WebCrypto with no runtime dependencies.
Rust validates X25519 public inputs with `curve25519-dalek`, already used through
Ed25519; low-order inputs producing an all-zero shared secret are rejected.
Clients perform the corresponding native key-agreement probe on enrollment.
Signing and encryption private keys remain independent.

Clients verify public coverage and decrypt their own entry before accepting the
rotation. If a known key disagrees with its locally decryptable envelope, stop.
The server cannot prove other recipients received the correct plaintext; a signed
bad envelope can strand its recipient. Recovery authority is trusted to construct
valid envelopes. Independent RFC fixtures and contextual tamper tests are required.

Ordinary data blocks still derive a separate AES-256-GCM key using a fresh public
block salt and the epoch key. Manifest, content, metadata, and thumbnail keys stay
independently random. Rotation does not re-encrypt earlier operations or blobs.

## Persistence, replay, and pairing

The chain store owns derived epoch keys in memory and wipes its owned buffers on
disposal. A durable device encryption private key plus a cached signed rotation
record can recover its secret after restart. Atomically persist verified records
and the monotonic head before exposing their state. Do not add a background
credential rewrite on every remotely observed rotation. Cache failure prevents
publication; invalid records cannot advance the trusted head.

Protected credentials keep the complete historical keyring obtained at creation,
pairing, or recovery. Those keys cover epochs before this device was enrolled;
subsequent keys are recoverable from its envelopes. Pairing exports a temporary
copy of the complete verified chain-store keyring, including derived epochs,
and wipes that copy after encryption. It never transfers either device private
key or any recovery secret. Key bindings and private-key possession are proved
through the authenticated seven-phase exchange described in the rotation plan.

Local credentials use a fixed MessagePack frame:

```
[1, origin, genesis_bytes, library_id,
 [signing_seed, signing_public_key, encryption_secret, encryption_public_key],
 numbered_epoch_keys, [head_sequence, head_hash], phase,
 pending_rotation_or_null, first_enrollment_or_null, recovery_enrollment_or_null]
```

Phases are `registering`, `pairing`, `active`, and `recovering`. A pending rotation
is `[next_epoch_secret, exact_signed_rotation_bytes]` and retains the same device
identity. A pending first/recovery enrollment is the exact signed record. Validate
phase, purpose, library, key correspondence, parent, signer, and local recipient
binding before loading. No portable device credential envelope exists.

## Creation, rotation, and device-free recovery

The session owns credential and recovery-file workflows; the root workspace owns
chain verification and selected materialized UI state. Components receive plain
props/callbacks and perform no cryptographic or persistence workflows.

Creation prepares a fresh device pair, recovery credential, minimal genesis, and
signed enrollment block 1. Save the protected registration candidate before POST.
Require downloading the recovery file before registration; after a restart,
resume with the matching file or explicitly discard the preparation. Verify the
exact accepted enrollment head before activating the device. The browser can
confirm download initiation, not that the user retained the file/password.

For rotation, an active device verifies current history, temporarily unlocks the
matching recovery file, derives the next epoch key with a fresh salt, seals it to
all authorized devices, and signs the exact parent transition. Save the pending
plan durably before submission; store no recovery secret in that plan. Block
unrelated UI writes while it is pending. Reconcile by exact chain inclusion/hash,
not by admission probes: devices remain authorized before and after rotation.
Final credential persistence may save the full verified keyring and accepted
head while preserving the active signer, context, downloads, and previews.

Device-free restore uses the recovery signing key for bounded authenticated chain
reads. Verify canonical records, signatures, authority, parents, sequence, and all
private operations before accepting a head. Derive historical epoch keys only
from authenticated salts. Generate a fresh device pair and a recovery-signed
enrollment against the verified head; save that local candidate before submission.
Its signing key may submit the exact enrollment without any other device. Exact
verified enrollment, not ping alone, establishes readiness. Restore leaves the
epoch and existing membership unchanged. Rotation is a separate explicit action.
At capacity, recovery-signed revocation can free a slot before enrollment.

Moved parents require verified replay and renewed recovery-file authorization to
prepare a different signed plan. Never silently rebase. Unknown outcomes preserve
exact signed bytes and local credentials for retry/reconciliation. Cancellation
aborts owned requests and suppresses stale UI updates; accepted records cannot be
undone. Failed local preparation prevents publication. Failed final persistence
preserves the pending outcome rather than discarding the only credentials.

## Recovery file and limits of recovery

Recovery plaintext is `[1, normalized_server_origin, genesis_bytes, library_id,
[recovery_signing_seed, recovery_signing_public_key], epoch_derivation_secret]`.
Its envelope is `["i2nclip-library-recovery", 1, password_envelope]`, with AAD
`i2nclip/library-recovery/1`, existing password-KDF bounds, and a 1 MiB file bound.
Validate seed/public correspondence, genesis hash, fixed authority, and origin.

Each export generates a fresh password from 32 random bytes, encoded as 43-character
base64url. Display/copy it separately from the file; never put it in the file or
IndexedDB. The local unlock password is separate and user-chosen. Keep the same
in-memory artifact/password after failed download/copy, replace both on a new
export, and clear owned temporary secrets on completion/cancellation. Devices do
not retain the recovery key. The file and its password together restore control.

The same recovery file derives every epoch, including future epochs. Its loss
prevents recovery/rotation; its disclosure compromises recovery authority and all
epoch secrets. Rotation excludes revoked devices from future epoch keys, but
cannot erase copied keys, old plaintext, earlier chain ciphertext, or known blob
keys. Purged blobs cannot be recovered by this file. Invalid trusted-writer
operations and server withholding remain availability failures; this is not a
chain rewind or a consensus system. Fresh restore has only its offline genesis
anchor, so an unseen server suffix cannot be proven absent.

### Freeing device capacity during recovery

The recovery import form optionally accepts the full signing public key of one
active device to revoke. Blank preserves all devices. The action explicitly says
it will revoke a device. At 128 active devices, choose a target before enrolling.
The session saves a local candidate first, then submits and verifies the root-signed
revocation before preparing enrollment against its accepted head. A failure may
leave revocation committed and enrollment pending; reopen the recovery file to
verify current history and prepare again. Root secrets are never saved locally.
Revocation does not rotate keys; rotate separately to protect future epochs.
