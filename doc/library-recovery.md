# Library recovery and epoch-reset change specification

This supersedes device-authorized rotation in `blockchain-storage.md`. There are
no live databases or compatible formats to preserve. Use these names everywhere:
**recovery key**, **recovery file**, **recovery signing keypair**, **epoch key**,
and **device backup**. Do not use owner key, master seed, or recovery key as aliases
for ordinary device credentials.

## Goal and scope

An immutable authority independent of all devices must approve every epoch reset
and restore a usable library even when no device remains authorized. One recovery
file must recover all historical epoch keys without being updated at every reset.
Ordinary devices retain equal file, enrollment, revocation, and purge authority.
Only the recovery signing keypair can authorize `rotate` records. Reset remains
an append to the existing chain, not a rewind or state rollback.

Exclude recovery-key replacement, device permissions, automatic recovery-key
storage on devices, recovery-key transfer during pairing, and erasure of secrets
already copied by other parties. Purged blobs cannot be recovered by this key.
This change does not repair a trusted writer's invalid encrypted operation or
restore availability when the server withholds data.

## Cryptographic derivations and formats

The recovery key is a credential containing two independently generated secrets:
an Ed25519 recovery signing private key and a uniformly random 32-byte epoch
derivation secret. Generate the signing keypair with WebCrypto, export its seed
and public key for the encrypted file, and import a non-extractable runtime signing
handle. Pin its public key in genesis. No public-key derivation dependency is
needed. Validate imported seed/public-key correspondence by signing and verifying
a probe using WebCrypto; reject mismatches. Signing, HKDF, and AEAD use WebCrypto.
The two secrets are preserved together; neither is derived from the other.

Canonical genesis is `[1, recovery_public_key, initial_device_public_key,
epoch_1_salt, 1]`. All three binary fields are 32 bytes, and the two public keys
must be distinct. Keep the existing domain-separated genesis hash; its value
remains both library ID and sequence-zero head. The initial device is ordinary,
revocable membership. The recovery public key is immutable and never enrolled
as a device.

For epoch `e`, derive a 32-byte epoch key with HKDF-SHA256:

- Input key material: epoch derivation secret.
- Salt: that epoch's fresh, public, random 32-byte salt.
- Info: MessagePack `["i2nclip/epoch-key/1", library_id, e]`.

Epoch 1's salt is in genesis. A `rotate` record's effects become
`[next_epoch, initial_device_public_key, next_epoch_salt]`. Its signer is the
recovery public key, its record epoch is the old epoch, and its encryption fields
are null. The recovery signature authenticates the parent, sequence, library,
new epoch, new device, and new salt. Ordinary records still require an active
device signature. Reset signatures do not grant file-operation authority.

Genesis and reset are symmetric epoch starts: each names that epoch's initial
authorized device. Reset acceptance revokes every previous device and authorizes
this initial device atomically, without a separate enrollment block. Subsequent
devices are enrolled normally. This resets membership, not file state/history.

Devices hold only their Ed25519 device key and numbered epoch keys, not the
recovery key or recovery signing seed. Known epoch keys do not allow deriving
other epoch keys or the recovery key. The existing per-block HKDF/salt/AES-GCM
scheme remains separate and unchanged. Manifest, content, metadata, and thumbnail
keys remain independently random.

Recovery plaintext is `[1, server_origin, genesis_bytes, library_id,
[signing_seed, signing_public_key], epoch_derivation_secret]`. Both secrets are
32 bytes; the public key is also 32 bytes.
The portable envelope is `["i2nclip-library-recovery", 1, password_envelope]`, with
AAD `i2nclip/library-recovery/1`, the existing password KDF bounds, and a 1 MiB
encoded-file bound. Validate the signing public key against genesis, recompute
library ID, and validate the normalized server origin before use. Device backup
and recovery-file discriminators/AAD are deliberately distinct.

Every portable export generates a fresh password from 32 random bytes, encoded as
base64url. The user does not choose that password. Display it with the encrypted
file's download action and a copy action, explaining that both are required for
restoration and the password must be stored securely and separately. Never put
the password inside the file or IndexedDB. Retain the same in-memory file/password
pair after failed download/copy attempts; a new export replaces both. Wipe owned
random buffers and clear the displayed password/artifact when its workflow ends.
The local application unlock password remains a separate, user-chosen password.
No application claim can prove the user retained either downloaded material.

The recovery file grants reset authority and historical decryption. Its loss
prevents future resets, but active devices retain ordinary access. Its disclosure
compromises all epochs, including future epochs under this fixed recovery key.
An old device backup does not substitute for it.

## Server interfaces and persistence

The server receives the recovery public key and salts, never the recovery key,
signing seed, epoch derivation secret, or epoch keys. Registration becomes `[invitation_code,
recovery_public_key, epoch_1_salt]`, signed by the initial device. Atomically save
genesis, both public principals, initial device membership, and quota while
consuming the invitation. Keep the fresh `sql/001_init.sql` baseline policy.

Keep one global public-key namespace in `library_keys`: public key, library ID,
fixed kind (`device` or `recovery`), authorization sequence, and optional revocation
sequence. Recovery rows are sequence zero, immutable, and non-revocable. Device
membership changes cannot reuse a recovery key, including across libraries.
Blocks may reference either principal as signer; record kind determines authority.
The client membership map still contains devices only. This is a fixed protocol
distinction, not a general permission system.

API paths remain the same; signer identity selects the one library:

- `GET /api/blocks`: active devices or the matching recovery signing key may
  request bounded, pinned history. Recovery reads exist so no device is needed
  to reconstruct epoch keys and materialize the chain.
- Ordinary blob/quota/pairing and ping requests: active devices only. Recovery
  signing authority does not implicitly grant these operational endpoints.
- `POST /api/blocks`: verify HTTP proof of key possession and bound the request
  before processing. Under the library lock, ordinary records require matching
  HTTP/block signers and current device membership. For `rotate`, verify the
  immutable recovery signer; the HTTP signer may be that recovery key, an active
  library device, or the exact replacement key named by the signed record.
  This lets a pending device backup submit the already authorized reset without
  containing the recovery key or requiring an old active device.

Recheck all relevant membership after acquiring the library lock. Preserve exact
parent/sequence/epoch compare-and-append, fresh-key checks, atomic revocation of
all prior devices, and enrollment of the replacement. Exact accepted record
retries do not apply effects twice. A reset does not rewrite earlier ciphertext.
Unknown replacement keys cannot publish ordinary records or read the chain.

## Client ownership and lifecycle

The session owns creation, recovery-file use, and protected device credentials.
The workspace owns ordinary chain synchronization and materialized views. The
recovery workflow is an explicit, cancellable operation; it does not become an
ordinary workspace identity or persist the recovery key in IndexedDB. Components
receive plain props/callbacks and never handle cryptographic workflows.

At library creation, generate the recovery key, initial device, and epoch-1 salt.
Derive epoch 1, preserve the device registration candidate, and require downloading
the recovery file encrypted with its automatically generated password before registration. Keep the recovery key
only in the creation operation's memory and wipe owned temporary buffers. A
restart before registration must not silently create a library whose recovery
file was never downloaded; import the matching recovery file or explicitly
discard that unregistered preparation and start again. Download initiation cannot
prove the user retained a file; say this beside the action.

An active device prepares an expected head and replacement device. Unlock the
recovery file only for an explicitly requested reset, check its genesis/library
against the active library, derive the next epoch key with a fresh salt, and sign
the exact transition. Save the protected pending plan and download a pending
**device backup** with a separately generated export password before submission. Do not include the recovery key in that plan.
Preserve the existing active context while preparing; block unrelated UI writes
until the pending reset is resolved. Dispose the old context on final acceptance.

For recovery with no active device, unlock the recovery file and authenticate
chain reads with its recovery signing key. Starting from genesis, verify canonical
records, signatures, public authority transitions, parents, and sequence. Derive
keys from authenticated epoch salts and decrypt/reduce every private operation
before accepting the corresponding state. Reuse bounded replay and cache writes;
never pin a record based on public-header verification alone. The temporary
recovery replay may obtain each next epoch key as a verified reset is reached.
It exposes no ordinary mutation controls. Fresh-server suffix withholding behind
an offline file's last known anchor remains an inherent limitation.

After replay, generate a fresh replacement device and sign a reset against the
verified head. A pending recovery identity has phase `resetting`, uses the fresh
replacement device as its current credential, and carries the exact reset plus
all historical epoch keys and the next epoch key. Its pending-plan replacement
key may equal its current key in this phase; ordinary active-device preparations
still keep old and replacement keys distinct. It has no ready library context
until acceptance is verified. Download its pending device backup, then submit
using replacement-device HTTP signatures. Wipe the recovery key after preparing
the durable signed plan; it is not needed to submit that exact plan.

## Failures and cancellation

Probe replacement credentials first after an unknown result. If authorized,
verify the exact signed reset through its hash and finalize the device identity.
Otherwise an active old device may verify its parent and retry. A `resetting`
identity with no old device may submit its exact recovery-signed record directly;
a moved-parent conflict requires unlocking the recovery file, reconstructing
against current verified history, and downloading a new pending device backup.
Do not silently rebase a signed reset or regenerate one during outcome checks.

Storage failure leaves the old durable credentials and pending plan intact.
Failed downloads never enable submission. Cancellation aborts owned requests and
suppresses stale UI updates. Once the server has accepted a reset, cancellation
cannot undo it; keep sufficient pending credentials to reconcile. Neither a
401 alone nor a generic conflict establishes acceptance or permanent loss.

No-data availability, invalid chain data, unavailable historical salts/records,
wrong passwords, wrong-library files, and signing-key/public-key mismatch must
produce explicit errors. Never fall back to a fresh or shorter chain.

## Acceptance checks and commit sequence

Implement as separate cohesive commits; use only focused checks per commit:

1. Commit the amended specification and consistent naming.
2. Recovery-key derivation and recovery-file formats: deterministic fixtures,
   wrong purpose/password/library, bounds, signing seed/public-key correspondence,
   and known-epoch isolation; client/Rust shared vectors where applicable.
3. Device formats with recovery genesis and public epoch salts:
   strict canonical parsing, genesis hash, reset authority, and replay tests.
4. Fresh SQL baseline, global public principals, registration and HTTP admission:
   focused isolated database/API tests, concurrent appends, no cross-library
   reuse, recovery-only chain reads, and unauthorized replacement rejection.
5. Session creation, temporary recovery replay, and pending reset/reconciliation:
   focused restart, cancellation, download, storage-failure, stale-parent, and
   no-authorized-device tests. Device backup alone must submit/reconcile an exact
   already signed reset without ever gaining recovery authority.
6. Continue pairing, materialized UI, deletion/history, and the remaining main
   implementation plan. Complete the final legacy cleanup and full integration
   verification after the chain features work; do not run E2E for each change.

### Two-secret recovery acceptance checks

Creation must use independent native key generation and random epoch derivation
material. Recovery export/import must preserve both secrets and reject missing or
mismatched signing credentials, wrong library, password, purpose, or oversized
files. Neither secret is stored in ordinary device credentials or pairing.
Cancellation and workflow disposal wipe both owned secret buffers. No old
single-secret recovery format is supported. Dependency manifests and lockfiles
must contain no added Ed25519 package. No server interface or genesis change is
introduced by splitting these private secrets.
