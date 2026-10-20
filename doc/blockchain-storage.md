# Blockchain storage specification

Status: proposed; not implemented. This is the specification for the greenfield
replacement of the current server-managed media records and tag index. It
supersedes the abandoned cryptography redesign and the intermediate proposals
for owner authority, permissions, recovery envelopes, and chain rewind.

## Goal and boundaries

Make the authenticated operation chain authoritative. Clients independently
verify it, materialize library state, load encrypted metadata, and search locally.
The server stores opaque objects and records, authenticates devices, serializes
appends, accounts for storage, and expires abandoned uploads. It cannot decrypt
file operations or validate their private semantics.

The deployment remains one web app served alongside its API on the same origin.
There is one unnamed library per configured client session. A device public key
belongs to exactly one library; a library may have many devices. Library identity
is resolved from the request signer, not selected through an API URL.

### Trust model

- Every active device has full authority, including enrollment, revocation,
  file mutation, permanent purge, and epoch rotation. There are no permissions,
  roles, permanent owners, or privileged recovery credentials.
- Enrolled writers are trusted to create valid operations. A compromised device
  can destroy data, revoke other devices, or interrupt replay. This design does
  not attempt to contain an authorized malicious writer.
- The storage server is untrusted for confidentiality, record integrity, and
  completeness. Clients validate records and objects; availability is not
  guaranteed. Trust in the delivered application code is separate: malicious
  same-origin JavaScript can access an unlocked session.
- Clients pin accepted heads. A server cannot silently roll back behind a
  retained head or substitute incompatible history. It can withhold a newer
  suffix that the client and its pairing source have never observed.
- Revocation denies future authenticated server access and appends. It cannot
  retract ciphertext, plaintext, signing-key copies, or encryption secrets.
  Rotation protects newly encrypted operations from devices without the new
  secret; it does not re-encrypt old content.
- Purge removes application-controlled stored objects. It cannot prove erasure
  from server backups, browser caches, or copies made by another device. Opaque
  IDs, ciphertext hashes, keys inside old encrypted operations, and lifecycle
  history remain in the chain.

### Exclusions

No distributed consensus, proof of work, CRDT, multi-library UI, server-side
search, global deduplication, permission language, permanent recovery authority,
chain truncation/rewind, automatic GC of committed objects, persistent decrypted
search index, or speculative snapshots. No legacy format readers or migrations
of existing application data. Read-only time travel is a separate final feature.
Whole-library state restoration is excluded.

## Keys, identity, and initialization

### Library and genesis

Generate an independent Ed25519 signing seed and a random 32-byte epoch-1
encryption secret locally. Canonical genesis is the MessagePack array
`[1, initial_device_public_key, 1]`. Its hash is:

```text
SHA256(UTF8("i2nclip/chain/genesis/1\n") || genesis_bytes)
```

This hash is both the stable library ID and sequence-zero head. Genesis
authorizes the initial device and establishes epoch 1. The initial key has no
permanent privilege and may later be revoked. Neither the library ID nor genesis
changes during rotation.

Registration retains invitation-code admission and signed proof of key
possession. The server derives genesis from the registering key and atomically
creates the library, membership, and quota record while consuming the invitation.
The encryption secret never reaches it. Registration retries reuse the same
candidate, check whether it is already registered, and do not spend another code
after successful registration. Preserve the candidate in the protected local
session before sending registration, so an accepted-but-lost response or reload
does not lose its credentials.

### Key ownership

| Material | Purpose and location |
| --- | --- |
| Device signing seed | HTTP and block signatures; password-protected local identity and device backup |
| Epoch secrets | Per-block encryption key derivation; protected identity, authenticated pairing, and backups |
| Manifest key | Fresh random AES key per immutable manifest; inside encrypted `AddFile` |
| Content key | Fresh random AES key per file; inside its encrypted manifest |
| Metadata key | Fresh random AES key per metadata version; inside its encrypted operation |
| Thumbnail key | Fresh random AES key per thumbnail version; inside encrypted metadata |

Signing keys and epoch secrets are independent. Paired devices generate their
own signing keys; pairing never clones the sender's signing seed. Retain all
historical epoch secrets needed for full replay. Epoch secrets are not derived
from one another. Use non-extractable runtime keys where practical and wipe
temporary owned byte buffers; browser memory and strings cannot be reliably
erased.

## Chain protocol

### Encoding and limits

All new fixed protocol structures use compact, fixed-position MessagePack arrays,
including API request/response frames, cryptographic structures, manifests,
credentials, backup documents, and pairing control packets. Do not encode their
fixed fields as key-value maps. Use minimal integer
encodings, binary values for keys/hashes/ciphertext, and no extension types or
floating-point fields. Integers are nonnegative JavaScript-safe integers. Decode
strictly, reject trailing bytes and wrong shapes, and check canonical encoding
against shared Rust/JavaScript fixtures. General private metadata remains a map.

Public keys and hashes are 32 bytes; signatures are 64 bytes; file IDs are fresh
32-byte random values. HTTP path IDs/hashes use lowercase hexadecimal. Keep the
existing HTTP request public-key encoding and signing envelope.

Bounds are checked before allocation, encryption, and database transactions:

| Item | Limit |
| --- | --- |
| Complete encoded block record | 64 KiB |
| Block page | At most 128 records and 1 MiB of encoded response |
| Content plaintext chunk | 4 MiB; empty files have one empty chunk |
| Raw encrypted content chunk | 4 MiB + 16-byte GCM tag |
| Generic stored blob | 4 MiB + 64 bytes |
| Manifest plaintext | 4 MiB, subject to the encoded blob limit |
| Metadata plaintext | Existing 65,472-byte budget, without embedded thumbnail bytes |
| Encoded device backup | 1 MiB |
| Credential plaintext | 1 MiB minus 1 KiB for envelope overhead |
| Files in one purge operation | 256, also subject to the block limit |

Reject a file before reading/uploading content if its required manifest cannot
fit. Calculate the encoded manifest size using fixed-width placeholder hashes;
do not discover this only after uploading its chunks. Backups and pairing must
fit their limits; rotation checks the expanded credential bundle before changing
server state. These bounds are deliberate limits, not reasons to add manifest
trees or unlimited transfer formats.

### Signed record

The exact signed body is:

```text
[
  version,
  library_id,
  sequence,
  previous_hash,
  epoch,
  signer_public_key,
  kind,
  effects,
  salt_or_null,
  nonce_or_null,
  encrypted_operation_or_null
]
```

`version` is 1. `sequence` is the parent sequence plus one. `epoch` is the
pre-operation epoch, including for rotation. `kind` is one of `data`, `enroll`,
`revoke`, or `rotate`. The public header is the array of the first ten fields.

```text
signature = Ed25519.Sign(
  device_key,
  UTF8("i2nclip/chain/sign/1\n") || signed_body_bytes
)
record_bytes = MessagePack([signed_body_bytes, signature])
block_hash = SHA256(UTF8("i2nclip/chain/block/1\n") || record_bytes)
```

Transmit and persist the exact signed bytes. Indexed database fields are checked
projections, never alternative unsigned sources of truth. HTTP request signatures
remain separate and cover method, origin, exact target, timestamp, nonce, and
body digest using the existing request protocol.

For `data` blocks, generate a fresh 32-byte public salt and 12-byte nonce. Derive
an AES-256-GCM key with HKDF-SHA256: input is the current epoch secret, salt is
the public block salt, and info is MessagePack
`["i2nclip/chain/key/1", library_id, epoch]`. AAD is
`UTF8("i2nclip/chain/aad/1\n") || MessagePack(public_header)`.
The ciphertext contains the authentication tag. All header fields, including
salt and nonce, are signed and bound to the encryption.

Membership and rotation records are public, signed operations with null salt,
nonce, and ciphertext. Clients and the server reject incompatible kind/effect
combinations. Authentication and authorization always use the state before the
record is applied.

### Private file operations

An object reference is `[ciphertext_hash, raw_decryption_key]`. Private payloads
are fixed arrays with these shapes:

```text
["AddFile", file_id, manifest_reference, metadata_reference]
["ReplaceMetadata", file_id, metadata_reference]
["DeleteFile", file_id]
["RestoreFile", file_id]
["PurgeFiles", sorted_unique_file_ids]
```

`AddFile` requires a never-used file ID. Metadata replacement and deletion
require a live file. Restoration requires a deleted, unpurged file. Purge
requires currently deleted, unpurged files; it is irreversible. Operations
commit complete metadata documents, not patches. A repeated accepted record is
idempotent; a new record repeating an invalid lifecycle transition is invalid.

Materialized state tracks each file's creation sequence, immutable manifest
reference, latest metadata reference, deletion state, and purge state. Default
ordering is creation sequence descending, then file ID. Informational timestamps
belong in encrypted metadata and are not trusted server time.

Historical references need not remain fetchable. Structural operation validation
and replay must not depend on downloading old metadata, manifests, or thumbnails.
Validate referenced object contents when fetched. A retained object's absence is
an availability error; a purged object's absence is expected.

### Public effects

For a `data` record, effects are an array containing the corresponding storage
effect, or an empty array for logical delete/restore:

```text
["publish", file_id, inventory_digest]
["commit", file_id, sorted_unique_new_blob_hashes]
["purge", sorted_unique_file_ids]
```

Publication commits the complete staged inventory of a new file. Its digest is
SHA-256 over MessagePack
`["i2nclip/inventory/1", library_id, file_id, entries]`, where `entries` is the
array of `[hash, ciphertext_length]` sorted lexicographically by raw hash bytes.
The client computes it from its uploads; the server recomputes it transactionally.
A changed/expired inventory returns a conflict without publishing anything.
This keeps the content's full chunk-hash array outside the chain.

Metadata replacement commits its newly uploaded metadata and optional thumbnail
blobs. Previously committed thumbnail blobs may be reused. New uploads not named
by an accepted commitment remain staged and expire. Purge deletes every blob
version belonging to the named files.

Clients check correspondence between decrypted operations and public effects.
During replay this means matching operation/effect kinds and file IDs, enforcing
effect shapes, and validating directly available references. The initial
inventory digest is an authenticated opaque commitment: the publisher computes
it and the server checks the staged inventory. Replaying old history does not
require downloading or reconstructing that inventory after its objects are
purged. Manifest and metadata content validation remains lazy.
The server checks public effects, ownership, and availability, but cannot check
encrypted lifecycle semantics or prove a ciphertext is a valid private operation.
Effects reveal publication, commitment, purge relationships, ciphertext sizes,
and access patterns. Names, tags, thumbnail identity, content dimensions, and
ordinary edit/delete/restore operation types remain private.

### Membership and epoch transitions

For `enroll`, effects are `[new_device_public_key]`. The key must never have been
enrolled, including in another library. For `revoke`, effects are
`[active_target_public_key]`. Any active signer may issue either operation;
revocation must leave at least one active device. A signer may revoke itself
when another active device remains.

For `rotate`, effects are `[next_epoch, new_device_public_key]`. The next epoch is
exactly the previous epoch plus one, and the replacement key is fresh. Atomically
revoke every old device and authorize the replacement. Genesis and library ID
stay unchanged. No epoch secret or recovery envelope appears in the public
transition. The initiating client already holds the new secret; other devices
must re-pair to get it. All transitions use ordinary active-device authority.

## Encrypted file objects

The `blobs` table stores all deletable data without a public type column:
content chunks, manifests, metadata versions, and thumbnails. SHA-256 of the
exact stored bytes identifies a blob within its library/file namespace. No
cross-file or cross-library deduplication is introduced.

Metadata, manifest, and thumbnail blobs use independent fresh random AES-256-GCM
keys and nonces. Their encoded envelope is `[1, nonce, ciphertext_with_tag]`.
AAD is MessagePack `["i2nclip/object/1", library_id, file_id, purpose]`, where
purpose is `manifest`, `metadata`, or `thumbnail`.

Manifest plaintext is a versioned document containing plaintext size, chunk size,
chunk count, raw content key, and ordered ciphertext chunk hashes. It contains no
thumbnail. Content remains the existing raw v2 AES-GCM chunk format: a fresh file
ID and content key per upload, index-derived IV, and file/position/dimension AAD.
The containing manifest is bound to the library and file. Verify hash, exact
length, and AEAD authentication before exposing a complete chunk's plaintext.

Metadata contains name, readable tags, other extensible attributes, and an
optional thumbnail reference. Preserve existing tag normalization and first
spelling on deduplication; remove HMAC search tokens and separately encrypted tag
labels. A thumbnail change produces a new thumbnail blob and complete metadata
version. Every historical version remains retained until file purge.

An operation authenticates its metadata/manifest ciphertext hashes; a manifest
authenticates chunk hashes and ordering; metadata authenticates the thumbnail
reference. A client need not fetch content or manifests to build the file index.

## Server persistence

Retain registration-code and request-nonce storage. The final application tables
have this shape; implement all key/hash length, safe-integer, foreign-key, and
nonnegative/accounting constraints in the numbered migration:

| Table | Columns and constraints |
| --- | --- |
| `libraries` | `id` PK, `genesis_device_key`, `head_hash`, `head_sequence`, `epoch`, `max_blob_bytes`, `used_blob_bytes`, `max_files`, `retained_files` |
| `devices` | `public_key` globally unique PK, `library_id` FK, `authorized_at_sequence`, nullable `revoked_at_sequence` |
| `blocks` | `library_id` FK, `sequence`, `hash`, `previous_hash`, `signer_key`, exact `signed_body`, `signature`; PK `(library_id, sequence)`, unique `(library_id, hash)` and `(library_id, previous_hash)` |
| `files` | `library_id` FK, `file_id`, `status`, nullable `staging_expires_at`; PK `(library_id, file_id)` |
| `blobs` | `library_id`, `file_id`, `hash`, `ciphertext BYTEA STORAGE EXTERNAL`, nullable `committed_at_sequence`, nullable `staging_expires_at`; PK `(library_id, file_id, hash)`, FK to file |

File status is `TEXT CHECK` with `staging`, `retained`, and `purged`. Rust uses
an enum. This is storage lifecycle, not private logical deletion. Keep purged
file tombstones to prevent ID reuse. Do not remove device history or blocks.
Blocks do not require referenced blob rows to remain present.

Each blob is either committed with no expiry or staged with an expiry. Committed
bytes and identities are immutable. Block records are immutable. Add an expiry
index for staged blobs/files and indexes supporting ordered block pages and
active-device lookup. Do not create metadata, tag, chunk-index, or blob-type
columns.

### Quotas, admission, and maintenance

Charge staged and retained ciphertext, including all metadata/thumbnail versions,
against blob quota. Reserve a file slot at initial staging; logical deletion
does not free it. Publication reuses that reservation, purge frees it, and a
purged tombstone does not consume a retained-file slot. Enforce limits from
database values and actual stored bytes, not client claims.

Report immutable log bytes separately from reclaimable blob usage. Chain growth
is an explicit retention cost; this work does not add log compaction or an
unbounded-data DoS guarantee against authorized writers. Preserve existing
bounded request admission, body deadlines, and pairing rate limits.

Expire only uncommitted uploads. Use the existing 24-hour partial-upload policy,
measured from actual new-byte progress. Identical retries do not indefinitely
extend the deadline. Expire abandoned staged metadata on retained files too.
Cleanup releases accounting exactly once and never deletes committed history.
Maintenance, publication, upload insertion, and purge serialize through the
owning library row; do not hold it while reading network bodies.

### Migration and cutover

The user explicitly authorizes dropping existing application databases and
replacing `sql/001_init.sql` directly for this greenfield cutover. Define only
the new schema in that baseline; do not add a `002` migration, legacy-schema
detection, conversion, or compatibility behavior. Document database recreation
before deployment. SQLx checksum validation will reject an old database until it
is recreated; never edit its migration ledger to disguise the changed baseline.
Startup does not automatically erase databases. Subsequent changes after this
baseline is established return to ordinary numbered migrations.

The implementation branch need not be deployable at every intermediate commit.
Keep commits compiling without warnings; deploy after the client/server cutover.
Do not add runtime dual readers, fallback routes, or temporary compatibility
state merely to make intermediate commits independently deployable.

## HTTP API

All core routes require the existing signed request envelope. Resolve the current
device membership from the signer. Keep health, registration, signed ping/quota,
and pairing routes; registration is the sole invitation-based enrollment path
outside an existing library. Normal device enrollment occurs in the chain.

| Endpoint | Request and result |
| --- | --- |
| `POST /api/blocks` | Encoded signed record; returns accepted hash/sequence/head; `409` on stale parent or unavailable inventory |
| `GET /api/blocks?after=HASH&until=HASH` | Bounded contiguous page `[target_head, target_sequence, blocks, next_after]` |
| `POST /api/blobs` | MessagePack `[file_id, ciphertext]`; returns independently checked `[hash]` |
| `GET /api/blobs/{file_id}/{hash}` | Raw committed ciphertext, bounded while streaming |
| `GET /api/quota` | Live `[max_blob_bytes, max_files, used_blob_bytes, retained_files, log_bytes]`; log bytes count stored signed bodies and signatures |

`after` is required and may be genesis. The first request omits `until` and pins
the server's selected current head; subsequent pages use that same target. Reject
unknown anchors, an `until` before `after`, and inconsistent targets. Never fall
back silently to genesis. The target is a pagination boundary, not proof of
global freshness. Pages must include at least one record if records remain.

Upload creates a staging file/reservation on the first blob when needed. Repeated
identical uploads are idempotent, neither double-charge nor replace bytes, and
remain valid for an existing committed hash. Uploads to purged files fail. Newly
staged blobs are not downloadable through ordinary blob reads before commitment.

Append reads and bounds its body before acquiring a transaction. Under the
library row lock, recheck the request device's current membership, record signer,
epoch, expected head, canonical shape, strict signature, and public effects.
For a new record, request signer and record signer must match. Atomically append,
apply effects, update membership/storage/quota, and advance the head.

An exact accepted record retry from a still-active signer succeeds without
reapplying effects, even if later records have advanced the head. Accepted
rotation revokes its old request signer: reconcile using replacement credentials
and a chain read, rather than allowing a revoked key a general retry exception.
Never mistake an unrelated `409` for proof the submitted operation committed.

Retain MessagePack errors and existing authentication/body-limit/deadline status
conventions. Error responses expose no private metadata. Immutable ciphertext
responses may use existing private HTTP caching; already cached data cannot be
remotely erased after purge or revocation. Metadata/index data is not served as
unsigned authoritative server state.

Remove server list/search/tag catalog, per-file metadata-update, indexed chunk,
and direct file-delete endpoints after client cutover. There is no independent
blob-delete route that bypasses a purge block.

## Client ownership and persistence

The unlocked application session owns a single chain store, including on fresh
direct-media routes. It owns synchronization, verification, replay, append
coordination, and accepted state. Workspaces consume this state rather than
creating another synchronizer. Session initialization, pairing, uploads, content
streams, quota, and media stores retain explicit owners and cancellation.

Pure protocol functions do not depend on stores, rendering, or storage. Views
receive the particular stores they need; components receive plain data and
callbacks. No HTML IDs. Navigation preserves root-owned operations; locking,
identity changes, successful rotation, and disposal invalidate old contexts and
cancel their resources.

### Selected materialized view as the rendering contract

The chain-backed UI is a function of the selected materialized view state at all
times. Live browsing and time travel use the same rendering path, components,
search derivation, and media projection. Time travel changes the selected view;
it does not introduce a second historical library implementation or scattered
"if historical, fetch/render differently" branches in components.

The session-owned chain store distinguishes verified live protocol state from
the selected presentation projection. The selected view identifies its exact
head/sequence and live-or-historical selection mode, and supplies the file state,
resolved metadata/loading/errors, search/catalog inputs, content availability,
and read-only status consumed by library views. Any chain-derived device/epoch
information displayed for a historical selection is explicitly historical;
command authorization always uses the separately maintained verified live state.

All chain-backed visible data must be derived from that selected projection.
Views must not mix selected file records with metadata, search results, or media
items taken directly from a different live/historical state. Existing stores
retain their responsibilities and explicit dependencies; this contract does not
create a catch-all store for the whole application. Ordinary presentation state
such as focus, disclosures, and query drafts remains local to its existing owner.
Uploads, session state, and quota reads retain their live lifecycles and are not
rewound; their presentation and permitted actions must be explicit when a
historical selection is active.

Selecting a head materializes it and publishes its identity and corresponding
state atomically. While preparing a selection, expose loading without labeling
the previous selection's data as the new one. Metadata/search/media work is bound
to the selection generation and exact object references. Cancel or ignore stale
results on selection changes and release superseded preview resources; a reused
file ID alone is insufficient to identify a metadata version or media item.

Live selection follows the accepted live head. Historical selection stays pinned
while synchronization advances live protocol state. Project current permanent
purge/availability information into the selected view without rewriting its
historical file facts. Components consume the resulting unavailable/read-only
state rather than consulting a separate live ledger to decide how to render.
Returning to live is another selection change, not a special UI reconstruction.

Build this boundary before implementing time-travel controls. Historical
selection then changes only the materialized view input; the existing UI renders
the result, including its read-only and availability states.

### IndexedDB

Scope history by normalized server origin and library ID even though the UI
supports one library. Persist exact encrypted records and the trusted accepted
head atomically in dedicated stores; do not rewrite the entire chain as one
session value. Keep device keys, epoch secrets, initialization candidates, and
pending rotation protected by the existing local password envelope. Preserve
Remember this device and revision-checked session replacement semantics.

Materialized operations, decrypted metadata, search indexes, thumbnails, and
upload queues stay in memory. No persistent blob cache is added. Replay cached
history on unlock; stream/batch records from IndexedDB rather than requiring the
whole log in RAM. Historical epoch secrets remain in the protected identity.

Validate a bounded batch before committing it and its head, then expose accepted
state. On storage failure, retain the old durable head, show a local storage
error, and stop mutations until persistence works. A missing cache can be rebuilt
from genesis only while preserving and checking the separately retained trusted
head; never accept a shorter chain by treating cache damage as a new client.

Tabs load credentials once and remain independent. Do not add notifications,
polling, focus checks, or application locks. IndexedDB compare-and-update prevents
head regression; a stale tab must reconcile a newer stored prefix before writing
its own batch. Reset/forget explicitly disposes decrypted resources and removes
that session's stored identity/history; explain that removing the trusted head
also removes its local rollback protection.

### Verification and synchronization

On startup, recompute genesis, validate cached records and the pinned head, then
request a bounded extension to a fixed target. Verify byte encodings, hashes,
signatures, parent/sequence/epoch, membership transitions, decryption, and private
operation/effect correspondence before acceptance. Do not silently skip a bad
record or advance the trusted head past one. Preserve last verified state for
inspection and expose a clear integrity error; no admin rewind is implemented.

Synchronize on initial session readiness, explicit refresh, before preparing a
new mutation, and when reconciling an uncertain append/conflict. Reads are
deduplicated and cancellable. No background polling or cross-tab synchronization.
Other devices' changes become visible at those synchronization points.

Each mutation captures its source head and must still match it after any sync.
A changed head preserves the user's draft and returns a conflict requiring an
explicit retry. Never silently rebase, including an upload prepared against an
older head. Reconcile an unknown outcome by finding the exact signed record/hash
before preparing another operation.

Revocation/epoch changes invalidate an affected session's pending writes. A
revoked device cannot use its old backup to bypass membership. Ordinary bounded
reads already admitted or HTTP-cached ciphertext may survive revocation; no
claim of remote memory/cache erasure is made.

### Materialization and search

Replay builds references and lifecycle state without content downloads. Load only
metadata relevant to the selected view, authenticate it, and derive that view's
names/tags/search in RAM.
Retain the current normalized-tag query and local presentation pagination;
server result cursors and tag tokens disappear. Tag normalization/deduplication
keeps its existing behavior.

Show metadata indexing progress and incomplete/missing-object errors. A partial
index must never be presented as a complete search with no matches. Distinguish
an empty library, a complete search with no matches, and unavailable metadata.
Use deterministic chain-based default ordering. Request historical metadata only
when browsing history, not during ordinary initial synchronization.

Direct links also verify the chain before trusting a file reference. They may
avoid indexing unrelated metadata but cannot bypass history verification by
trusting a server-supplied file summary.

### Upload, edit, and download lifecycle

Check local size and quota before reading bytes, preserve current optional
compression/preparation behavior, and encrypt/upload content sequentially in
bounded chunks. Keep only hashes and necessary preparation state in memory.
Upload the encrypted manifest, optional thumbnail, and complete metadata, then
publish through `AddFile` and its exact inventory digest. The file is invisible
until verified append acceptance.

Metadata edits merge against the verified current document, preserve unknown
fields, upload fresh immutable versions, and append `ReplaceMetadata`. Preserve
failed drafts and local staged references for explicit retry; do not persist
upload workflows. A failed file does not stop the remaining batch.

Downloads fetch manifests and chunks lazily by hash. Validate ciphertext hash,
object context, exact chunk length, and complete-chunk authentication before
exposing plaintext. Preserve bounded preview ranges, session-owned downloads,
native playback, and object-URL disposal. Stale work must not publish URLs or
open a save dialog after its owner ends.

## Pairing and device backups

### Pairing

Keep the existing OPAQUE exchange, explicit human verification-code comparison,
relay expiry, request deadlines, and capability isolation. Bind the receiver's
fresh public key to the authenticated exchange. Pairing transfers encryption
secrets and trust anchors, never the sender's signing key.

After authenticated approval, the logical exchange is:

1. Sender transfers genesis/library identity, historical epoch secrets, trusted
   head, and the proposed enrollment record through the encrypted channel.
2. Receiver checks its own public key and selected origin, validates the bundle,
   and durably saves pending credentials before acknowledging preparation.
3. Sender appends the exact enrollment against its expected parent. Conflicts
   require a fresh explicit attempt; do not silently substitute a new record.
4. Sender reports the accepted record. Receiver reads with its new credentials,
   verifies genesis through the transferred head and enrollment, persists the
   accepted head, and acknowledges activation.

Version the relay workflow for these phases. Keep tight existing bounds for
OPAQUE messages. Permit the encrypted credential packet up to the backup-sized
bound plus framing, with an aggregate 16 MiB stored-message budget across rooms;
reject admission without retaining oversized state. Do not raise every PAKE
message limit or retain every old transfer packet. Preserve existing room/rate
limits and single in-flight requests.

An interrupted pending receiver can inspect/retry activation with its own key.
Enrollment that already committed remains in history even if acknowledgment or
pairing is cancelled; report it and permit explicit revocation. Do not pretend
cancellation rolled back a committed membership change.

The sender's trusted head is an authenticated minimum. The receiver must verify
through that exact hash, rejecting shorter or conflicting history. This closes
the unanchored-fresh-client gap for pairing without claiming either device knows
about all newer server history.

### Device backup

Use a new password-encrypted MessagePack device-backup document, protected by the
existing PBKDF2-HMAC-SHA256/AES-GCM envelope and iteration/size bounds with a new
backup-specific AAD context. No cryptographic KDF redesign is included here.

The credential plaintext includes version, normalized server origin, genesis,
library ID, device signing seed/public key, epoch-number/secret pairs, and trusted
head/sequence. Validate signing-key correspondence, genesis identity, distinct
epochs, and bounds before installation. Epoch secrets, not merely the current
secret, are needed for full history replay.

A backup restores that logical device. It is not a perpetual master credential
and does not contain file blobs. A revoked backup cannot restore server authority;
an old backup cannot decrypt a later epoch without re-pairing. A still-active
backup must verify through its pinned head before readiness. Never enroll a
fresh key automatically merely because an old backup was imported.

### Rotation and interrupted outcomes

Rotation is a session-owned operation and requires no owner key:

1. Synchronize and capture the expected head. Generate a fresh signing keypair
   and independent epoch secret.
2. Construct the exact old-device-signed transition and persist a protected
   pending record containing old credentials, replacement credentials, all epoch
   secrets, expected parent, and transition bytes/hash.
3. Download a password-encrypted pending device backup. Include the same pending
   material so a new client can reconcile either outcome. Enable submission only
   after the download action succeeds; browsers cannot prove the user retained
   the file, so explain that limitation beside the action.
4. Submit the exact transition. On verified acceptance, persist the resulting
   trusted head, install the replacement context, and dispose old work. Offer a
   finalized backup containing the accepted head.

After a restart or unknown result, probe replacement credentials first. If
authorized, fetch and verify the exact transition. Otherwise use the protected
old credentials to inspect and retry the original record if its parent is still
current. A moved parent requires explicit reconstruction and a newly downloaded
backup. Neither authorization failure alone nor a generic conflict proves what
happened. If another transition revoked both candidates, report lost authority
instead of claiming recovery succeeded.

Keep pending credentials until the outcome is durably reconciled. The previously
downloaded pending backup remains usable after acceptance. Its old signing key
is revoked, but its replacement key can inspect the committed transition.

## Deletion and read-only time travel

Logical delete retains manifest, content, thumbnails, and every metadata version.
Restore is a new operation against the current head. Explicit purge selects
deleted files and atomically commits the purge block, deletes all associated
blobs, marks tombstones, and releases storage/file accounting. Do not
automatically garbage-collect committed versions, even when superseded.

Invalidation cancels current streams, clears decrypted metadata/thumbnails, and
revokes owned URLs for purged files. Other devices reconcile when they next
synchronize. Past data already copied elsewhere remains outside this guarantee.

Time travel is a separate final feature: select a cached-history sequence through
the same materialized-view contract, lazily load its metadata, and let the
existing library UI render the clearly read-only projection. Keep
the live authorization state, current epoch, and trusted live head separate from
the viewed historical file state. Overlay current purge availability: old views
cannot resurrect missing objects.

Disable upload/edit/delete/restore/purge in historical views, including drop,
paste, extension handoff, and keyboard entry points. A mutation's source head
must remain the viewed head; never substitute the live one. Thus an accidentally
enabled mutation based on an older block is rejected by compare-and-append.
UI read-only guards still matter when the selected block happens to be the live
head. No historical editing, automatic rebasing, or fork creation is included.

## Commit-sized implementation sequence

Each numbered change is its own commit. Include meaningful tests with the change
they validate. Keep compilation/static checks clean while removing obsolete code
at the coordinated cutover; do not add production compatibility machinery to
make an intermediate branch independently deployable.

| Commit | Deliverable | Relevant verification |
| --- | --- | --- |
| 1 | Record this specification, index it, and persist efficient verification guidance in `AGENTS.md` | Documentation consistency and `git diff --check` only |
| 2 | Scope Makefile formatting/lint and pre-commit dispatch to changed subsystems; preserve explicit full-suite targets | Focused hook-dispatch checks for docs, backend, frontend, and shared changes |
| 3 | Define canonical genesis/records/effects, strict verification, per-block crypto, and shared vectors | Focused Rust and JavaScript protocol/vector tests |
| 4 | Implement the pure client membership/file reducer and lifecycle rules | Deterministic replay, tampering, invalid-operation, and epoch-transition tests |
| 5 | Replace `sql/001_init.sql` with the new baseline and implement persistence transactions for fresh databases | Fresh/reopen/concurrent initialization and isolated PostgreSQL invariant tests |
| 6 | Implement registration, signer-to-library resolution, append, pinned pagination, and quota responses | Focused Rust authentication/API/append-race tests |
| 7 | Implement hash-addressed blob staging, inventory publication, expiration, and transactional purge | Focused blob, accounting, maintenance, and race tests |
| 8 | Implement IndexedDB records/head transactions and the session-owned synchronizer | Focused storage, cancellation, rollback, and concurrent-tab tests |
| 9 | Implement device identities, durable initialization candidates, and normal device-backup import/export | Session, identity, initialization retry, and backup tests |
| 10 | Implement encrypted manifests, separate metadata/thumbnails, sequential staged upload, and hash-based reads | Content, metadata, download, and upload-store tests |
| 11 | Cut library/tag/media/deeplink workflows over to the selected materialized-view rendering contract; remove obsolete server media/tag routes and indexes | Relevant store/API tests, selection isolation tests, backend static checks, frontend checker/build |
| 12 | Implement fresh-device pairing, durable receiver preparation, trusted-head handoff, and relay phase/size changes | Real OPAQUE unit tests, pairing-store tests, focused Rust relay tests |
| 13 | Add device listing/revocation and crash-safe epoch rotation with pending backups | Membership, rotation, outcome reconciliation, and session lifecycle tests |
| 14 | Add deleted-file browsing, explicit restore, purge UI, and quota/history explanations | Lifecycle, stream invalidation, and relevant store tests; frontend checker/build |
| 15 | Add read-only time-travel selection through the existing materialized-view/UI path | Historical replay, selection changes, lazy old metadata, purge availability, and stale-parent rejection tests; frontend checker/build |
| 16 | Finish protocol/session/migration/test documentation, update browser fixtures, remove superseded helpers, and validate integration | Full portable suite once; inspect final Firefox screenshots |

Do not implement the old owner/recovery-envelope/permission proposals along the
way. The runtime and test reference crypto remain separate: production Rust
verifies public records and manages storage; test-only helpers may encrypt data
to produce cross-language fixtures.

## Acceptance and verification

Run only affected tests after each commit. Backend-only work does not trigger
frontend checks; frontend-only work does not run backend suites. Shared protocol
work runs its selected vectors in both languages. Documentation needs no build.
Scope formatting, static analysis, and warning-free builds similarly. Fix the
currently unconditional pre-commit invocation in commit 2 rather than repeatedly
paying for unrelated checks.

Use filtered `cargo test` and `make test-db TEST_ARGS=...` for backend changes,
and selected Node test files under the Node version in `client/.nvmrc` for client
work. Run the Svelte checker and warning-free web build for integrated UI/type
changes. Do not add tests that only restate implementation details.

Do not run E2E after every change. Group real-server Firefox/Chromium execution
and actual Firefox screenshot inspection into final integration verification,
unless a browser-only defect needs one focused test. Run `make test-all` once
after integration; repeat or broaden checks only for new changes, failures, or
unresolved concerns. Keep jobs sharing `client/dist/` sequential.

Required scenarios:

- Rust/JavaScript agree on genesis, signatures, hashes, canonical encoding,
  per-block derivation, object envelopes, inventories, and preserved chunk AEAD.
- Reject dropped prefixes/middle records, rewritten bodies, swapped objects,
  unauthorized signatures, wrong epochs, reused IDs/keys, malformed operations,
  invalid membership changes, and operation/effect mismatches. Never silently
  skip a bad encrypted operation.
- A saved or pairing-transferred head rejects shorter/conflicting history.
  Replay cached history without loading it all into RAM; missing cache records
  never reset the trusted minimum. Describe suffix withholding honestly.
- Concurrent appends yield one winner without partial effects. Revocation,
  rotation, staging expiration, publication, restore, and purge races preserve
  authorization, storage, and accounting invariants.
- Duplicate upload/append retries do not double-charge or repeat effects. Lost
  responses are reconciled by the exact record, including self-revocation and
  rotation where old credentials cease to authenticate.
- Missing purged objects do not prevent structural replay; missing retained
  metadata produces an explicit incomplete-index/availability state. Purge
  deletes every version and invalidates local resources without erasing history.
- Initial creation and pending rotation survive restart and server acceptance
  followed by local save failure. Test both accepted and unaccepted pending
  backups, moved parents, revoked backups, wrong passwords, and oversized bundles.
- Pairing uses different signing keys, transfers all necessary epoch secrets and
  the trusted minimum head, acknowledges durable preparation, and reports
  committed enrollment despite a lost final acknowledgment.
- Historical mutation entry points stay disabled and retain historical parent
  hashes even while the live chain advances. Current purge information overlays
  historical content availability.
- Live and historical selections use the same rendering/search/media path.
  Switching selections atomically pairs the displayed head with its file state;
  late metadata, search, or preview results cannot cross selection generations or
  object-reference versions. Live sync leaves a historical selection pinned;
  current purge availability is projected explicitly. Returning to live selects
  the latest verified projection without recreating a different library UI.
- Navigation preserves root work; locking, replacement, disposal, and rotation
  suppress stale results and release buffers/URLs. Existing compression,
  extension handoff, inline edits, streaming, playback, and direct links work.

Tests isolate databases, mutable stores, temporary files, and browser contexts;
listeners bind loopback port 0 atomically and clean up on success and failure.
Final visual review covers realistic media, errors, long names, both themes, and
320/360 px widths. Document prerequisites so checks work from a fresh clone.
