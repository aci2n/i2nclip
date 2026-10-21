# Device-preserving epoch rotation

Status: specified follow-up; **apply only after the current chain implementation
and its final verification are complete**. This document does not change current
runtime behavior. On implementation it supersedes the revoke-all rotation rules
in [library recovery](library-recovery.md) and [chain storage](blockchain-storage.md).
Do not implement compatibility readers or migrate existing credentials: this is
still a greenfield format change with disposable databases.

Approved refinement: [canonical genesis and separate enrollment](genesis-and-recovery-enrollment.md)
supersedes this document's initial-device genesis field and optional recovery
device inside rotation. Recovery enrollment becomes its own root-signed block;
rotation has no membership effects. Apply that document's resulting frame and
HPKE context when implementing this proposal.

## Goal, scope, and exclusions

Rotate the epoch encryption key without replacing or re-pairing authorized
devices. The recovery signing key remains the only rotation authority. A rotation
contains one encrypted next-epoch key envelope for every device authorized at its
parent. Devices retain their identities and authorization across rotation.

Revocation is a separate, preceding chain operation. Rotation neither implicitly
revokes devices nor selects a subset of the authorized membership. To exclude a
device, revoke it first, verify that accepted block, and construct rotation against
the resulting head. Rotation protects future epoch-encrypted operations, not
secrets or plaintext already copied by a revoked device.

Include creation, enrollment, pairing, server validation, independent replay,
offline recovery, pending-operation persistence, and selected-view behavior.
Exclude permissions, recovery-key replacement, device backups, automatic
rotation on revocation, background polling, consensus, history rewriting, and
re-encryption of existing blobs. Existing manifest/content/metadata/thumbnail keys
and per-block encryption remain unchanged. Old blob references and keys learned
before revocation remain usable against a cooperating or malicious server.

## Device key choice

Use two independently generated keypairs per device:

- Ed25519 signing keypair: existing HTTP proofs and chain signatures; its public
  key remains the device identity and API principal.
- X25519 encryption keypair: receives epoch-key envelopes; its private key is
  local-only, protected alongside the signing private key.

The chain stores **two device public keys**, never private keys. The encryption
key is not the offline recovery signing key. Pairing binds both public keys to
the same device; neither private key is transferred by the pairing peer.
Encryption-key replacement requires a new device enrollment and revocation of
the old device; no independent key-update operation is introduced.

Alternative considered: convert Ed25519 keys to X25519, deriving the encryption
private key and converting the public key instead of storing another public key.
This is possible using established conversion implementations, but Ed25519 itself
does not encrypt. It introduces conversion, point-validation, and shared-secret
validation rules, couples key use, and is not a WebCrypto Ed25519 operation.
Do not reinterpret an Ed25519 public key or seed as an X25519 key. The reduced
storage does not justify that complexity here. [Libsodium documents conversion
and recommends distinct keys](https://libsodium.gitbook.io/doc/advanced/ed25519-curve25519).

Use RFC 9180 HPKE base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
AES-256-GCM (suite IDs `0x0020`, `0x0001`, `0x0002`). The recovery signature
authenticates the complete rotation; HPKE base mode supplies recipient secrecy.
Use a maintained RFC-conforming implementation, pinned in the lockfile, and its
required input/all-zero shared-secret checks. Do not implement curve arithmetic,
conversion, or a custom public-key encryption construction. Implementation choice: pinned `hpke@1.1.7` (panva/hpke), which has zero runtime
dependencies and uses native WebCrypto. The X25519/AES-256-GCM import path is
tree-shakeable. Validate its browser availability through the creation/import key probes
and final browser suite. `client/tests/hpke-vector.json` preserves the relevant
official RFC base-mode fixture, and focused tests cover context separation,
tampering, invalid inputs, and non-extractable runtime private keys.
See [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html).

## Membership and fixed frames

Extend genesis's initial-device field to `[signing_public_key,
encryption_public_key]`. Extend enrollment effects to carry this same pair,
and bind both in the human-approved pairing transcript, proposed enrollment, and
receipt verification. Revocation still identifies a device by signing public key.
The recovery public key remains a distinct immutable principal, never a device.

Each public key is exactly 32 bytes. Reject invalid encryption keys, reuse of an
encryption public key by another device in the same library (including revoked
devices), and signing/recovery identity collisions. Validate possession of the
encryption private key before finishing enrollment: the existing pairing exchange
must carry a challenge encrypted to the proposed encryption key and a transcript-
bound confirmation from the receiver. Creation and offline recovery perform a
local encryption/decryption probe. The server cannot prove possession merely by
inspecting a public key; clients verify the enrollment workflow and signed binding.

Use positional MessagePack arrays for every fixed structure. Rotation effects:

```
[next_epoch, next_epoch_salt, recovery_device_or_null, envelopes]
recovery_device_or_null = null | [signing_public_key, encryption_public_key]
envelopes = [[device_signing_public_key, encapsulated_key, ciphertext], ...]
```

Ordinary rotation uses `null`. The optional fresh recovery device exists solely
for restoring control with the offline recovery file, as described below.
An envelope has 32-byte recipient identity, 32-byte HPKE encapsulation, and a
48-byte ciphertext for the 32-byte epoch key and authentication tag. Sort entries
lexicographically by signing-public-key bytes; reject duplicate or unsorted entries.

The record uses the old epoch, the recovery signer, and null ordinary block
encryption fields. Effects and envelopes are public but authenticated by the
record signature. They must be readable without possessing the next epoch key.
Never encrypt the outer rotation under the next or previous epoch key.

Retain deterministic next-epoch derivation from the recovery file's independent
epoch derivation secret, fresh public 32-byte salt, library ID, and next epoch
number exactly as in `library-recovery.md`. The file remains sufficient for all
historical and future epochs and is not updated on rotation.

For each recipient, independently run HPKE Seal on that derived 32-byte key.
Use fresh encapsulation randomness for every entry. Bind context with canonical
MessagePack:

```
info = ["i2nclip/epoch-envelope/1", library_id]
aad = ["i2nclip/epoch-envelope-context/1", library_id, sequence, parent_hash,
       old_epoch, next_epoch, next_epoch_salt, recovery_device_or_null,
       recipient_signing_public_key, recipient_encryption_public_key]
```

Both fields are encoded bytes, not JSON. Authentication binds an envelope to the
exact transition and the enrolled key binding; entries cannot be transplanted
between recipients, libraries, parents, or epochs. The root signature additionally
binds the entire envelope list. Plaintext contains only the next epoch key.

## Server admission, persistence, and limits

Keep existing API paths and the global signing-public-key principal namespace.
Encryption public keys do not authenticate HTTP requests or gain independent rows
as signing principals. Store each device's encryption public key with its device
membership; keep the recovery principal free of device-only fields. The chain is
authoritative, SQL membership is its transactionally maintained projection.

Under the library lock, verify the recovery signature, parent/sequence/epoch CAS,
fresh salt shape, and exact recipient set. It must equal membership authorized
at the parent plus the optional fresh recovery device. No revoked, missing,
duplicate, or unknown recipient is permitted. Compare with authoritative locked
membership, not a supplied client list. Reject over-limit records before mutation.
Preserve existing members and their authorization sequences. Advance the epoch
and, only when specified, enroll the fresh recovery device in the same transaction.
Do not reset revocation flags, quota, file state, or history.

Keep the 64 KiB record bound. Cap simultaneously authorized devices at 128,
including genesis and optional recovery enrollment; enforce in enrollment and
recovery rotation on server and client. A rotation for the maximum set must fit
the record bound, with a fixture verifying actual canonical encoded size. Do not
split an epoch transition across records or silently omit devices. Revoked keys
remain historical entries and do not count toward the active cap.

HTTP submission may be signed by the recovery key, a currently authorized device,
or the exact optional fresh recovery device named in the root-signed rotation.
The latter receives no ordinary API access before acceptance. Existing exact
record retry rules apply: an accepted rotation retry succeeds idempotently even
after the epoch advances. Recheck principal admission under the lock.

The server can validate recipient coverage and signatures but cannot verify that
every ciphertext contains the correct epoch key. Recovery authority is trusted
to construct valid envelopes. A malformed signed envelope can strand that device;
do not claim public verification proves correct delivery to every recipient.

## Client validation, ownership, and storage

Protocol modules own canonical parsing, HPKE context construction, and pure
membership reduction; no rendering dependencies. Stores own asynchronous
cryptography, durable credentials, requests, cancellation, and resource disposal.
Components receive ordinary state and callbacks. No store access or workflows
are added to components.

Before exposing a transition, independently verify signature, chain continuity,
authority, exact recipient coverage, bounds, and membership. An authorized device
opens its own entry using its local encryption private key, validates a 32-byte
result, and durably saves the numbered epoch key before advancing its durable
trusted head or exposing subsequent decrypted state. Stage replay changes until
both key persistence and verified cache advancement can be safely completed;
restart must be able to replay the same rotation without skipping its envelope.
Never persist a head whose required secret has been discarded.

A revoked device is not a recipient. It may verify public history available from
an untrusted server but cannot derive the new key from old epoch keys. Do not
treat the absence of its own envelope as malformed when it is no longer a member.
Normal operational endpoints still reject revoked devices.

An offline authorized device can replay any number of rotations in order and
open its entry in each, without the recovery file, a live pairing peer, or a
previous-epoch envelope key. Pairing still securely supplies historical epoch keys
and a trusted head to a newly enrolled device. Device private keys and epoch
keyrings remain local-only; there is no device export format.

Update protected device credentials to contain both private keypairs and their
public bindings. Extend registration, canonical genesis, enrollment, pairing,
recovery candidates, independent replay, SQL projections, and shared vectors as
one greenfield protocol change. Keep passwords and recovery secrets out of the
chain, server, ordinary credentials, and logs.

## Offline recovery without any device

Preserve recovery-file restore. After root-authenticated verified replay, generate
a fresh device signing/encryption pair. Prepare a rotation with that pair in
`recovery_device_or_null`, envelopes for every currently authorized device, and
an envelope for the fresh device. Existing devices remain authorized even if all
their private keys have been lost. This is explicit root-authorized recovery
enrollment, not revocation or replacement of existing membership.

The fresh signing key may submit the exact root-signed candidate as today. Save
its two keypairs, historical epoch keys, next key, and exact record durably before
submission. Wipe recovery secrets after preparation; retain enough local state
to retry and reconcile without reopening the file. Recovery replay derives epoch
keys from verified salts and does not need another device's encryption key.

Approved capacity policy: at most 128 devices are simultaneously authorized.
The offline recovery key may sign revocations to free capacity before a fresh
recovery enrollment, even without any usable device. The separate-enrollment
specification defines this authority and explicit user selection; rotation never
implicitly revokes devices. Revoked devices do not count toward the limit.

## Races, failures, and cancellation

Enrollment or revocation after preparation invalidates the parent and recipient
set. Reject the stale rotation atomically. Reconstruct against a newly verified
head only with explicit recovery-file authorization; never silently re-sign or
alter a pending candidate. A concurrent revoke/rotate pair has one accepted order.
If rotation wins, revocation takes effect afterward and another rotation is
needed to exclude that device from subsequent epoch secrets. Present this clearly.

Unknown submission outcome retains the exact pending record and credentials.
Verify inclusion by its exact hash and reconcile before retrying or preparing
another rotation. Storage failure before durable preparation prevents submission.
Cancellation aborts owned work and suppresses stale UI updates; it cannot undo an
accepted record. Do not replace existing device identities during ordinary
rotation. Dispose temporary plaintext keys and HPKE contexts when work ends.

On missing envelopes, wrong bindings, invalid HPKE inputs, or AEAD failure, stop
replay with an explicit error and retain the last verified view/head. Never use an
old key for a new epoch, guess an entry, silently re-pair, or accept a shorter
chain. Keep the valid local device credentials for diagnosis or recovery.

Rotation does not change the selected materialized file view. Historical browsing
remains read-only; current authorization, epoch readiness, quota, and purge
availability remain current operational state. UI file content continues to be a
function of the selected materialized view, not a separate rotation snapshot.

## Commit plan and acceptance checks

After the current implementation is finished, make separate cohesive commits:

1. Finalize the HPKE dependency choice and protocol fixtures. Test RFC vectors,
   context separation, wrong recipient, bad ciphertext, invalid public inputs,
   maximum encoded size, and deterministic epoch derivation. No custom crypto.
2. Add two-key local device credentials and enrollment/genesis frames. Test strict
   parsing, key correspondence, duplicate binding rejection, and no secret export.
3. Update SQL baseline, registration, membership projection, and locked rotation
   admission. Test exact recipient sets, retained membership, root-only authority,
   revoked-recipient rejection, capacity, concurrent membership changes, and retries
   using isolated backend databases. No frontend suite for this commit.
4. Update pairing's two-public-key transcript and encryption-key possession
   confirmation. Test substitution, wrong private key, cancellation, failed durable
   save, and exact receipt verification with focused client tests.
5. Implement envelope replay and ordinary device-preserving rotation workflows.
   Test two retained devices, one revoked device, offline multi-rotation catch-up,
   key-save failure/restart, stale parent, lost response, and cancellation.
6. Update root-only restore and pending recovery enrollment. Test zero usable
   devices, preservation of existing membership, candidate-only retry, recovery-signed revocation at capacity,
   and recovery-file derivation of all epoch keys without envelopes.
7. Update UI wording and operational readiness, remove revoke-all/reset-replacement
   code, update normative docs and shared vectors, and remove stale fixtures.
   Test selected-view invariants and inspect actual Firefox screenshots if visuals
   change. Run focused checks throughout; run the full suite once at completion,
   including a browser scenario proving retained devices need no re-pairing and a
   revoked device cannot decrypt post-rotation operations.

Do not weaken test isolation, introduce compatibility behavior, or run the full
E2E suite after each commit. Current recovery-file naming and the separate offline
recovery signing/epoch derivation secrets remain unchanged.
