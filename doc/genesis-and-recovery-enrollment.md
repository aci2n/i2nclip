# Canonical genesis and separate device enrollment

Status: implemented and integration-verified. See [verification results](chain-verification.md). This greenfield
refinement accompanies [device-preserving rotation](device-preserving-rotation.md).
The consolidated current contract is [library recovery](library-recovery.md).

## Goal and scope

Genesis defines immutable library identity and recovery authority. Device
membership starts in a separate signed block. Store canonical genesis bytes
instead of decomposing genesis into columns, and use `library_keys` as the
server's queryable recovery-authority projection.

Include genesis, registration, enrollment authorization, server projections,
independent client verification, offline recovery, durable pending operations,
and their tests. Preserve the approved separate Ed25519 signing and X25519
encryption keypairs per device.

Exclude permissions, recovery-key replacement, recovery-signed file operations,
membership changes inside rotation, device backups,
chain rewrites, historical blob re-encryption, and compatibility formats. This
remains a greenfield change: use fresh databases and update `sql/001_init.sql`
as part of the authorized cutover, without conversion migrations or fallback
readers. No new dependencies are needed beyond the rotation proposal.

## Genesis and independent trust

Canonical genesis is the positional MessagePack frame:

```
[1, recovery_signing_public_key, epoch_1_salt]
```

Both binary fields are exactly 32 bytes. Validate the signing public key and
require canonical encoding, exact arity, supported version, and bounded input.
The existing domain-separated SHA-256 genesis hash remains the library ID and
sequence-zero head. The changed frame changes the resulting ID; no old frame is
accepted. Epoch 1 is implicit. Keep its existing HKDF derivation and purpose.

Genesis contains no device, device encryption key, or mutable membership.
Its recovery signing public key is immutable. Clients establish authority from
these authenticated bytes and their trusted library ID, never from an unsigned
API response or SQL membership projection. Pairing and recovery files retain
canonical genesis bytes and verify the hash before using them. A new client
still needs a trusted anchor; hashing server-provided genesis alone does not
authenticate which library the user intended.

## Enrollment authority and first block

Keep one `enroll` record kind and the normal two-key enrollment effects defined
by the rotation proposal. An enrollment may be signed by either:

- An authorized device at the record's parent, using the existing pairing flow.
- The immutable recovery signing key pinned in genesis, including when no device
  is authorized.

The recovery key may also sign revocation records, including revocation of the
last authorized device. This explicitly permits device-free recovery to free
capacity at the approved limit of 128 authorized devices. Ordinary device-signed
revocation still requires a surviving authorized device. Recovery revocation
uses the existing `revoke` kind, requires an active target, and never revokes the
recovery principal. HTTP submission must be signed by the recovery key or an
active device; the target key receives no submission exception. A prepared
recovery-signed revocation can therefore be relayed by an active device, but
device-free restore keeps the recovery signer temporarily until those records
are submitted or durably stores their exact recovery-signed HTTP-independent
plans for later submission after re-unlock. Do not persist recovery secrets.

These rights do not grant ordinary blob,
quota, pairing, or file-operation access to the recovery principal. Rotation
remains recovery-only. No separate owner/admin device role is introduced.

The first record is an ordinary-format recovery-signed enrollment: sequence 1,
parent equal to the genesis hash, library equal to that hash, epoch 1, and null
ordinary block encryption fields. Its effects bind the fresh device's signing
and encryption public keys. It must be the first record; reject any other first
kind or device-signed bootstrap. At sequence 0 the materialized library is empty
and has no devices; at sequence 1 the initial device is authorized. Do not hide
or renumber this block in history.

Apply ordinary key validity, non-reuse, distinct recovery/device identity, and
encryption-key possession requirements. Creation and root-only recovery generate
both device keys locally and probe their correspondence; ordinary pairing proves
possession through its authenticated exchange. Recovery signatures are trusted
authorization, not public proof that a remote device possesses its private keys.

## Atomic registration and interfaces

Keep `POST /api/register-key` and existing bounded possession-based HTTP proof.
Its fixed request becomes:

```
[invitation_code, canonical_genesis_bytes, signed_first_enrollment_bytes]
```

The HTTP signer must equal the enrolled device signing key, proving possession
before registration. Verify genesis, library hash, recovery signature, first
record fields, and device binding before consuming an invitation. In one database
transaction consume the invitation, insert the library, insert its recovery
principal, append enrollment block 1, insert the device projection, and set head
to block 1. A failure rolls back everything, including invitation consumption.
No committed library may exist in a partially registered sequence-zero state.

Return the existing successful registration response shape; the client already
knows the exact first block and its hash. Persist those bytes before submission.
An exact retry must recognize the same genesis, first block, and HTTP device
binding without consuming another invitation. A differing first enrollment for
the same genesis is a conflict, even if recovery-signed. Retrying registration
does not reauthorize a subsequently revoked device or reset any membership.

For subsequent `POST /api/blocks`, recovery-signed enrollment can be submitted
with HTTP proof from the recovery key, an active library device, or the exact
fresh device named in the signed enrollment. Verify the block's recovery signature
and its fresh-device binding before granting this narrow submission exception.
An unknown candidate gains no chain/blob/quota/pairing access before acceptance.
Device-signed enrollment still requires matching active HTTP/block signers.
Recheck authority, key uniqueness, capacity, and parent/sequence/epoch under the
library lock. Preserve exact accepted-record retries without reapplying effects.

Chain read/page interfaces remain bounded and pinned. Recover the genesis bytes
from the library row wherever bootstrap needs them; no new public lookup or
unauthenticated enumeration endpoint is required by this change.

## SQL shape and authority ownership

`libraries` becomes:

```
id, genesis,
head_hash, head_sequence, epoch,
max_blob_bytes, used_blob_bytes, max_files, retained_files
```

Add immutable bounded `genesis BYTEA NOT NULL`. Remove `genesis_device_key`,
`recovery_public_key`, and `epoch_1_salt`. Validate canonical genesis and its ID
on registration; protect both `id` and `genesis` from update. Never regenerate
genesis from mutable projections. Its fixed frame needs at most 128 encoded bytes;
enforce this input/storage bound as well as parser validation.

`library_keys` retains the global signing-public-key namespace and immutable
`kind`, library binding, and authorization/revocation sequences. Recovery rows
remain authorized at sequence 0 and non-revocable. Initial devices are authorized
at sequence 1; later devices use their enrollment sequence. Store device encryption
public keys as required by the rotation proposal, with none on recovery rows.

Add a partial unique index on `library_keys(library_id)` for `kind = 'recovery'`
to enforce **at most one** recovery principal. Atomic registration must insert
exactly one matching genesis; existing no-delete/immutable-identity constraints
then preserve it. A unique index alone does not enforce existence or agreement
with genesis: cover those invariants in the registration transaction and tests.

The server resolves recovery authority by joining the immutable recovery row for
the locked library. Missing, multiple, or genesis-inconsistent recovery projection
is an integrity error, never permission to accept another signer. Validate agreement
when loading genesis/authority; ordinary client verification independently uses
genesis. No private recovery material is stored in either table.

The chain/genesis is the authenticated source; SQL keys, head/epoch, and usage
counters are projections for efficient admission and operational enforcement.
Quota remains server policy outside the chain. Do not remove unrelated useful
projections or introduce automatic projection-repair workflows in this change.

## Creation, recovery, and client lifecycle

The session store owns creation and recovery; protocol modules own pure frame
parsing and authority rules. Components retain plain props/callbacks. Preserve
root-owned operations across navigation, local busy guards, independent tabs,
cancellation, and stale-result checks; add no cross-tab coordination.

Creation generates recovery material, genesis, and the fresh device pair, then
prepares the exact root-signed first enrollment. The recovery file contains the
new canonical genesis and unchanged two recovery secrets; no device private key.
Keep the generated-password/download gate before registration. Save the protected
device candidate and exact registration plan durably before submission, without
persisting recovery secrets or the recovery-file password. Finalize only after
registration and verification of the exact block-1 head. Restart retries the same
prepared registration rather than generating another enrollment.

Offline recovery verifies history from genesis using recovery-authenticated reads
and derives historical epoch keys from authenticated salts. It generates a fresh
two-key device and prepares a recovery-signed enrollment against the verified
head. Persist the candidate, known epochs, trusted parent, and exact signed record
before submission. Candidate-signed HTTP submission permits completion after
recovery secrets have been wiped from memory. Activation requires verification
of the exact accepted enrollment, not merely a successful ping.

The minimal restore flow prepares and submits enrollment only. After verified
activation, rotation is an explicit separate action using the recovery file.
This restores control without replacing membership or automatically advancing the
epoch. Recovery-signed revocations remain explicit user-selected operations, and
are needed to free capacity when the authorized device limit is full.

Rotation is a separate operation after enrollment. It has envelopes for **all**
devices authorized at its parent and no recovery-device field or membership effect:

```
[next_epoch, next_epoch_salt, envelopes]
```

Remove `recovery_device_or_null` from the proposed HPKE context as well; all other
library/parent/sequence/epoch/recipient bindings remain. Recovery may prepare the
enrollment and its exact child rotation while the file is unlocked, saving both
signed records and the next epoch key locally before submission. These are two
independently accepted appends, not one atomic server operation. If enrollment
succeeds and rotation fails, the device remains authorized in the current epoch;
show partial completion and retain the pending rotation for reconciliation.
Never imply that recovery enrollment itself rotates secrets or revokes devices.

At the 128-authorized-device cap, offline recovery explicitly prepares and submits
recovery-signed revocation of a user-selected obsolete device before enrollment.
Never silently choose or revoke a device. Show the resulting membership change
and require that workflow's explicit action. Verify the accepted revocation head
before constructing enrollment; parent conflicts require replay and reauthorization.
Revocation does not erase old secrets: rotate afterward to exclude revoked
devices from the next epoch. The recovery key can revoke every device if explicitly
requested, and remains able to authorize a new enrollment afterward.

## Failures and cancellation

Wrong recovery files, mismatched signing keys, invalid genesis/hash, malformed
first blocks, key collisions, invalid signatures, and incorrect HTTP candidate
bindings fail without consuming invitations or applying membership effects.

On an unknown result, reconcile the exact prepared record by hash. A successful
retry is not evidence that the candidate remains authorized at the latest head;
verify intervening membership before activating a writable workspace. Parent
conflicts require verified replay and renewed recovery authorization to prepare
a different signed enrollment/rotation. Never silently rebase signed records.

Local persistence failure prevents publication. Cancellation aborts owned requests
and suppresses stale UI updates, but cannot undo accepted registration/enrollment.
Retain durable pending candidates for restart and exact reconciliation; explicit
local forgetting may discard them. Accepted membership never depends on a
component remaining mounted. Recovery private material stays temporary and is
wiped when its operation ends. Historical UI remains a function of selected
materialized state; current authorization and quota do not rewind with history.

## Implementation commits and acceptance

After the current implementation is ready, make separate cohesive commits:

1. Canonical minimal genesis, recovery-file parsing, and root-enrollment authority:
   shared Rust/client vectors, canonical rejection, hash/authority mismatch, empty
   sequence-zero reduction, and required root-signed first block.
2. Fresh SQL baseline and atomic registration: focused isolated backend tests for
   rollback/invitation preservation, exact concurrent retries, different bootstrap
   conflicts, immutable genesis, exactly one matching recovery row, and initial
   authorization at sequence 1. Remove decomposed genesis columns and their reads.
3. Recovery enrollment admission and membership projection: focused backend tests
   for root/device authority, candidate-only submission, cross-library substitution,
   128-device capacity and recovery-signed revocation (including the last device),
   parent races, and no accidental ordinary recovery/candidate API access.
4. Creation and restart ownership: focused client tests for durable exact plans,
   recovery download gating, storage failure, cancellation, lost responses, and
   verification of block 1 before activation.
5. Offline recovery enrollment followed by separate rotation: focused client tests
   for no usable device, durable candidate-only retries, partial acceptance,
   intervening revocation, stale child rotation, and removal of rotation membership
   side effects. Update the envelope context and rotation fixtures consistently.
6. Update protocol/architecture docs, history expectations, pairing bootstrap
   fixtures, and cleanup of replacement-device assumptions. Run the full suite
   once after the combined follow-ups are finished; browser coverage must verify
   creation, pairing, device-free restore, and retained-device rotation. Use only
   relevant focused tests per earlier commit, not E2E after every change.

## Recovery revocation control

The recovery import form may name one existing device by its full signing public
key (64 hexadecimal characters). Leaving it blank preserves every device. The
submit label explicitly states that selecting a key revokes that device. This
also frees one slot at the active-device limit; no device is selected automatically.

The session verifies history and that the selected target is currently active.
It saves a fresh local recovery candidate before publishing the root-signed
revocation. The root-owned replay store submits against its verified parent and
verifies the accepted head using the ordinary append/reconciliation path. Only
then does it construct and save the candidate enrollment against that head.
The recovery secret remains in memory and is wiped when this workflow ends.

A failed local save publishes no revocation. Cancellation or an uncertain result
may leave a revocation accepted while enrollment is unfinished; the candidate
remains saved, and reopening the recovery file verifies the resulting history
before preparing another enrollment. A stale candidate is never silently rebased.
Revocation does not rotate keys. Acceptance checks cover explicit selection,
unchanged default behavior, persistence before mutation, invalid/inactive targets,
capacity, and failure after accepted revocation. No extra schema or API is needed.
