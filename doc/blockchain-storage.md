# Blockchain storage specification

Status: implementation in progress. This is the specification for the greenfield
replacement of the current server-managed media records and tag index. It
supersedes the abandoned cryptography redesign and the intermediate proposals
for permission systems, recovery envelopes, and chain rewind. The offline recovery
key described here supersedes the earlier equal-authority epoch-reset proposal.
The authoritative amendment is [Library recovery](library-recovery.md), including
deterministic epoch keys and recovery without any authorized device.

Review reminder: assess the [2026-10-21 branch review findings](branch-review-2026-10-21.md)
before final integration verification. The review records admission, ownership,
test coverage, and crypto integration concerns against `a70fceb`; reassess them
against subsequent changes and explicitly review the documented security limitations.

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

- Active devices have equal authority over enrollment, device revocation,
  file mutation, and permanent purge. Only a separate offline recovery signing key
  can authorize an epoch reset (`rotate`). This is one fixed authority boundary,
  not a device permission language or hierarchy of enrolled device roles.
- Genesis pins the recovery public key independently of the initial device. The
  recovery signing key is not an enrolled device; device enrollment and revocation cannot
  replace, revoke, or acquire its reset authority. Recovery-key replacement is out
  of scope for this implementation.
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
search, global deduplication, permission language, recovery-key replacement,
chain truncation/rewind, automatic GC of committed objects, persistent decrypted
search index, or speculative snapshots. No legacy format readers or migrations
of existing application data. Read-only time travel is a separate final feature.
Whole-library state restoration is excluded.

## Keys, identity, and initialization

### Library and genesis

Generate an independent recovery signing keypair, random 32-byte epoch
derivation secret, initial-device signing keypair, and fresh public 32-byte
epoch-1 salt. Derive the epoch key as specified in `library-recovery.md`. Canonical genesis is
`[1, recovery_public_key, epoch_1_salt]`.
The recovery and device public keys must be distinct. Its hash is:

```text
SHA256(UTF8("i2nclip/chain/genesis/1\n") || genesis_bytes)
```

This hash is both the stable library ID and sequence-zero head. Genesis
establishes epoch 1 with no authorized devices. A recovery-signed enrollment at
block 1 authorizes the initial device. The initial key has no
permanent privilege and may later be revoked. The separate recovery public key is
immutable and exclusively authorizes epoch resets. Neither the library ID nor
genesis changes during a reset.

Registration retains invitation-code admission and signed proof of key
possession. Its fixed frame is `[invitation_code, genesis_bytes,
signed_first_enrollment_bytes]`, signed at HTTP level by the enrolled device.
The server validates the canonical genesis and recovery-signed first block, and
atomically stores genesis, both public principals, block 1, membership, and quota
while consuming the invitation. `libraries` stores immutable canonical genesis;
`library_keys` projects recovery authority and membership. The encryption secret never reaches it. Registration retries reuse the same
candidate, check whether it is already registered, and do not spend another code
after successful registration. Preserve the candidate in the protected local
session before sending registration, so an accepted-but-lost response or reload
does not lose its credentials.

### Key ownership

| Material | Purpose and location |
| --- | --- |
| Recovery key | Credential containing independent signing and epoch derivation secrets in the separate recovery file; never transferred to devices |
| Recovery signing keypair | Independently generated reset authority and recovery chain-read signatures; public key fixed in genesis, private runtime handle temporary |
| Device signing seed | HTTP and ordinary block signatures; password-protected local identity only |
| Epoch keys | Per-block encryption key derivation; protected identity, authenticated pairing, and local identities |
| Manifest key | Fresh random AES key per immutable manifest; inside encrypted `AddFile` |
| Content key | Fresh random AES key per file; inside its encrypted manifest |
| Metadata key | Fresh random AES key per metadata version; inside its encrypted operation |
| Thumbnail key | Fresh random AES key per thumbnail version; inside encrypted metadata |

The recovery key is separate from every device signing key. Paired devices generate their
own signing keys; pairing never clones the sender's signing seed. Retain all
historical epoch keys needed for full replay. Epoch keys are derived independently from its epoch derivation secret using their public
salts and epoch/library contexts, never from one another. Use non-extractable runtime keys where practical and wipe
temporary owned byte buffers; browser memory and strings cannot be reliably
erased.

### Recovery-key lifecycle

The recovery key bundles two backed-up secrets: the recovery signing private
key and the epoch derivation secret. The latter derives numbered epoch keys
through HKDF. Genesis contains the recovery signing public key and the first public epoch salt; reset records
contain subsequent salts. The recovery file can reconstruct the historical keyring
and restore control without an authorized device. It does not restore purged
objects or fix an invalid operation written by a trusted device.

The recovery key is not stored in ordinary device credentials, transferred by
pairing, or persisted in IndexedDB. Use it only during creation and explicit reset
or recovery workflows. See `library-recovery.md` for the precise derivations,
recovery-read admission, pending reset identities, and lifecycle/failure rules.

## Chain protocol

### Encoding and limits

All new fixed protocol structures use compact, fixed-position MessagePack arrays,
including API request/response frames, cryptographic structures, manifests,
credentials, recovery documents, and pairing control packets. Do not encode their
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
| Encoded recovery file | 1 MiB |
| Credential plaintext | 1 MiB minus 1 KiB for envelope overhead |
| Files in one purge operation | 256, also subject to the block limit |

Reject a file before reading/uploading content if its required manifest cannot
fit. Calculate the encoded manifest size using fixed-width placeholder hashes;
do not discover this only after uploading its chunks. Recovery files and pairing must
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
an AES-256-GCM key with HKDF-SHA256: input is the current epoch key, salt is
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

For `rotate`, effects are `[next_epoch, initial_device_public_key, next_epoch_salt]`. The next epoch is
exactly the previous epoch plus one, the replacement key is fresh, and the public
epoch salt is a fresh random 32-byte value. Atomically
revoke every old device and authorize the replacement. Genesis and library ID
stay unchanged. No epoch key or recovery envelope appears in the public transition. The initiating
recovery operation derives the next epoch key from the epoch derivation secret
in the recovery credential and the signed public salt; other devices
must re-pair to get it. Unlike enrollment and revocation, `rotate` must be signed
by the immutable recovery public key from genesis. An ordinary device signature is
invalid for a reset, even when that device was the initial device. The recovery signing key
has no ordinary device membership and cannot sign file/enrollment/revocation
operations unless separately authorized through a future explicitly specified
change; enrolling the recovery signing key as a device is forbidden.

The reset still extends the current head with an exact parent/sequence/epoch
comparison. It does not rewind the log, erase invalid history, or restore deleted
objects. The recovery key can rederive historical epoch keys and hence decrypt
retained objects through their authenticated references; ordinary devices cannot
perform that derivation.

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

The manifest frame is `[1, plaintext_size, chunk_size, chunk_count,
raw_content_key, ordered_chunk_hashes]`, with a fixed 4 MiB chunk size. Calculate
its encoded size before reading the source using the fixed binary hash widths
and the MessagePack array-header width, without allocating placeholder hashes
for an already oversized file. The metadata frame is
`[1, extensible_attributes_map, thumbnail_reference_or_null]`; a thumbnail
reference is `[ciphertext_hash, object_key]`. Do not embed thumbnail bytes in it.

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
| `libraries` | `id` PK, `recovery_public_key`, `genesis_device_key`, `epoch_1_salt`, `head_hash`, `head_sequence`, `epoch`, `max_blob_bytes`, `used_blob_bytes`, `max_files`, `retained_files` |
| `library_keys` | `public_key` globally unique PK, `library_id` FK, fixed `kind` (`device` or `recovery`), `authorized_at_sequence`, nullable `revoked_at_sequence`; recovery rows are immutable sequence-zero authority |
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

All core routes require the existing signed request envelope. Resolve current
authority from the signer: ordinary routes require active devices, chain reads
also allow the recovery signing key, and reset submission admits the exact
replacement device as specified in `library-recovery.md`. Keep health,
registration, signed ping/quota,
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

Implement stateful stores and resource-owning storage/transport services with
private TypeScript classes, structural factories, bound public commands, and
ordinary private workflows, following `doc/store-classes.md`. Keep instance
resources out of factory closures. Stateless protocol transformations remain
functions; operation-local callbacks and promise handlers may capture their
operation's data.

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
session value. Keep device keys, epoch keys, initialization candidates, and
pending rotation protected by the existing local password envelope. Preserve
Remember this device and revision-checked session replacement semantics.

Materialized operations, decrypted metadata, search indexes, thumbnails, and
upload queues stay in memory. No persistent blob cache is added. Replay cached
history on unlock; stream/batch records from IndexedDB rather than requiring the
whole log in RAM. Historical epoch keys remain in the protected identity.

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
also removes its local rollback protection. Forget removes the protected identity
first, then clears its current-format chain cache. Reset removes local credentials
and clears all current-format `i2nclip-chain:<origin>:<library>` caches, including
while locked, using IndexedDB database enumeration and transactions rather than
waiting for other tabs to close database connections. Failed credential removal
must not clear trusted history. If history cleanup fails after credentials were
removed, report the partial outcome and offer Reset again; do not claim success.
Other live tabs retain their observed in-memory head and reject rollback even if
the shared durable cache is cleared.

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
revoked device cannot use its old local credentials to bypass membership. Ordinary bounded
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

## Pairing and local device credentials

### Pairing

Keep the existing OPAQUE exchange, explicit human verification-code comparison,
relay expiry, request deadlines, and capability isolation. Bind the receiver's
fresh public key to the authenticated exchange. Pairing transfers encryption
secrets and trust anchors, never the sender's signing key.

After authenticated approval, the logical exchange is:

1. Sender transfers genesis/library identity, historical epoch keys, trusted
   head, and the proposed enrollment record through the encrypted channel.
2. Receiver checks its own public key and selected origin, validates the bundle,
   and durably saves pending credentials before acknowledging preparation.
3. Sender appends the exact enrollment against its expected parent. Conflicts
   require a fresh explicit attempt; do not silently substitute a new record.
4. Sender reports the accepted record. Receiver reads with its new credentials,
   verifies genesis through the transferred head and enrollment, persists the
   accepted head, and acknowledges activation.

Version the relay workflow for these phases.

The ordered relay has seven messages: OPAQUE request (1), response (2),
OPAQUE finish plus encrypted receiver-key binding (3), encrypted transfer with
the exact proposed enrollment (4), encrypted durable-preparation acknowledgment
(5), encrypted enrollment acceptance (6), and encrypted activation acknowledgment
(7). Sender capabilities submit even steps and receiver capabilities submit odd
steps. Derive independent directional AES keys and bind each packet's phase to
its AAD. The phase-3 public-key binding is authenticated after OPAQUE finishes;
it never relies on an unsigned public-key field supplied by the relay.

The phase-3 message is `[opaque_finish_bytes, encrypted_binding_bytes]`;
binding plaintext is `[1, receiver_public_key]`. Transfer plaintext is
`[1, server_origin, genesis_bytes, library_id, [[epoch, key], ...],
[parent_sequence, parent_hash], exact_proposed_enrollment_bytes]`. The receiver
supplies its own locally generated private key; no signing secret appears in the
transfer. Check canonical framing, origin/library/genesis, contiguous epoch keys,
valid enrollment signature, target key, epoch, and exact parent/sequence before
saving. The pending receiver pins the proposed enrollment's hash/sequence, which
also authenticates its parent. It stays unready until replay verifies that record
and its membership. The phase-5 and phase-7 acknowledgment plaintexts are
`[1, true]`. Phase 6 is `[1, accepted_sequence, accepted_enrollment_hash]`, and must
match the exact pending enrollment. A sender creates/signs the proposal once,
publishes those exact bytes after durable preparation, and verifies acceptance;
no automatic rebase or substitute enrollment is allowed.

The pairing store owns the disposable relay/PAKE attempt and receiver key until
pending credentials have been durably saved. Session owns that local pending
identity afterward. Sender synchronization remains workspace-owned; pairing
cancellation must not cancel shared synchronization. Pending receiver activation
is cancellable and checks stale results. Cancellation after attempted enrollment
must say that membership may have committed and can be explicitly revoked.

Fixed relay requests are `[1]` (create), `[message]` (join), and `[step, message]`
(submit). Snapshots are `[1, room_id, instance, remaining_seconds, step,
message_or_null, capability_or_null]`. Only phase 4 can carry a credential-sized
packet; other messages retain the 8 KiB limit. Each complete HTTP frame is capped
at 1 MiB plus 128 bytes, and room messages share the 16 MiB aggregate budget.

Keep tight existing bounds for
OPAQUE messages. Permit the encrypted credential packet up to the credential-sized
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

### Local device credentials

Device signing keys and numbered epoch keys are stored only in the protected
local identity. There is no device export, portable device-backup format, or
import flow. A lost device must be paired again with a fresh signing key. If all
devices are lost, unlock the offline recovery file to verify history and authorize
an epoch reset naming a fresh initial device. The recovery file is the sole
portable credential; its generated password must be stored separately.

The credential plaintext includes version, normalized server origin, genesis,
library ID, device signing seed/public key, epoch-number/key pairs, and trusted
head/sequence. Validate signing-key correspondence, genesis identity, distinct
epochs, and bounds before installation. Epoch keys, not merely the current
secret, are needed for full history replay.

The credential frame is `[1, server_origin, genesis_bytes, library_id,
[signing_seed, signing_public_key], [[epoch, key], ...],
[trusted_sequence, trusted_hash], phase, pending_rotation_or_null]`.
Epoch pairs are complete and ordered from 1. `phase` is `registering`, `pairing`,
`active`, or `resetting`; an active device or a `resetting` recovery candidate can hold a pending reset. Its frame is
`[[replacement_seed, replacement_public_key], new_epoch_key,
exact_signed_transition_bytes]`. Validate that the transition extends the saved
head and names the genesis recovery signer, next epoch, and replacement key.
Registration candidates must describe their own genesis and epoch 1.

Local password envelopes remain `[1, password_salt, iterations, nonce,
ciphertext]`; local AES envelopes use `[1, nonce, ciphertext]`. Password salts
are 16 bytes, nonces are 12 bytes, and KDF bounds are 600,000–2,000,000 iterations.
There is no map-format or device-backup fallback.

### Rotation and interrupted outcomes

Epoch reset is a session-owned operation requiring a recovery signature. The
recovery key is never included in the local pending device plan or pairing transfer.
Its durable pending plan contains the exact recovery-signed transition:

1. Synchronize and capture the expected head. Generate a fresh device signing keypair and public epoch salt. Derive the next
   epoch key using the explicitly unlocked recovery file.
2. Obtain the recovery signature over the exact transition and persist a protected
   pending record containing old credentials, replacement credentials, all epoch
   secrets, expected parent, and transition bytes/hash.
3. Enable submission once the protected pending plan is durably saved locally.
   There is no device backup download or download gate.
4. Submit the exact transition. On verified acceptance, persist the resulting
   trusted head, install the replacement context, and dispose old work.

After a restart or unknown result, probe replacement credentials first. If
authorized, fetch and verify the exact transition. Otherwise use the protected
old credentials to inspect and retry the original record if its parent is still
current. A moved parent requires unlocking the recovery file, explicit reconstruction,
and durable replacement of the local pending plan. Neither authorization failure alone nor a generic conflict proves what
happened. If another transition revoked both candidates, report lost authority
instead of claiming recovery succeeded.

Keep pending credentials locally until the outcome is durably reconciled. If
local storage is lost, the pending candidate cannot be recovered from an export.
Pair with another active device, or use the recovery file to verify the current
head and authorize another reset. This also handles a reset accepted just before
its candidate credentials were lost. Repeated recovery never rewinds the chain.

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
Editors capture the selected head as an opaque revision token when a draft is
opened. Pass that token back with Save; reject a changed source before staging
or publishing. Keep a failed draft visible. After reporting a stale-source
failure, a further explicit Save may use the newly displayed revision; never
retry or rebase automatically. One-click delete/restore/purge capture the
currently selected head at the click.
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
| 9 | Implement device identities, durable initialization candidates, and local device credentials | Session, identity, initialization retry, and recovery-file download tests |
| 10 | Implement encrypted manifests, separate metadata/thumbnails, sequential staged upload, and hash-based reads | Content, metadata, download, and upload-store tests |
| 11 | Cut library/tag/media/deeplink workflows over to the selected materialized-view rendering contract; remove obsolete server media/tag routes and indexes | Relevant store/API tests, selection isolation tests, backend static checks, frontend checker/build |
| 12 | Implement fresh-device pairing, durable receiver preparation, trusted-head handoff, and relay phase/size changes | Real OPAQUE unit tests, pairing-store tests, focused Rust relay tests |
| 13 | Add device listing/revocation and crash-safe recovery-authorized epoch reset with durable local pending credentials | Membership, rotation, outcome reconciliation, and session lifecycle tests |
| 14 | Add deleted-file browsing, explicit restore, purge UI, and quota/history explanations | Lifecycle, stream invalidation, and relevant store tests; frontend checker/build |
| 15 | Add read-only time-travel selection through the existing materialized-view/UI path | Historical replay, selection changes, lazy old metadata, purge availability, and stale-parent rejection tests; frontend checker/build |
| 16 | After the chain features are complete, perform the dedicated legacy cleanup described below | Reference/import audit and smallest affected tests/checks; keep builds warning-free |
| 17 | Finish current protocol/session/migration/test documentation and browser fixtures, then validate integration | Full portable suite once; inspect final Firefox screenshots |

### Final legacy cleanup phase

Once initialization, chain replay, blob workflows, pairing, rotation, deletion,
and read-only time travel work, perform a distinct cleanup commit before final
integration verification. Remove obsolete server media/tag routes and queries,
server-search tokens/index helpers, seed-derived metadata/descriptor formats,
old identity/recovery/pairing adapters, superseded client workflows, unused
constants/types, stale test fixtures, and outdated documentation or scripts.
Do not retain a legacy path for compatibility or add flags to select old behavior.

Cutover commits may remove unreachable code earlier when necessary to keep builds
clean. This final phase audits the completed design for remnants rather than
delaying required removals until the end. Preserve the deliberately retained v2
content-chunk AEAD, HTTP request-signature construction, password protection,
OPAQUE primitives, and their meaningful regression coverage. Search for obsolete
endpoints/formats/imports and confirm every remaining match has a current use.

Do not reintroduce the abandoned recovery-envelope or device-permission
proposals. The recovery signing key authorizes resets and recovery history reads;
ordinary device authority stays separate. The runtime and test reference crypto remain separate: production Rust
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
- Pairing uses different signing keys, transfers all necessary epoch keys and
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
