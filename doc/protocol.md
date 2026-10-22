# Current protocol

This document and the [shared-seed contract](shared-seed/README.md) are the
current wire, storage and credential specification. There are no compatibility
readers.

## Library identity

One permanent Ed25519 seed is the shared library identity. Every browser holding
it has full authority over the library; there are no per-browser keys,
permissions, revocation, recovery principals, epochs or rotation.

```text
genesis        = MessagePack([1, signing_public_key])
library_id     = SHA256(UTF8("i2nclip/chain/genesis/1\n") || genesis)
encryption_root = HKDF-SHA256(salt = UTF8("i2nclip"), IKM = seed,
                              info = MessagePack(["i2nclip/library-encryption/1", library_id]))
```

The initial head is the genesis at sequence zero. Only
`client/src/lib/services/library-identity.ts` constructs, parses or exports
seed-bearing plaintext. Its callers (`stores/session.ts` and
`services/pairing-crypto.ts`) receive opaque handles, public identity values,
non-extractable runtime keys or sealed credentials. This is an audit boundary,
not a sandbox against same-origin code execution.

## Blocks

```text
body      = [1, library_id, sequence, previous_hash, effects, salt, nonce, ciphertext]
signature = Ed25519.Sign(seed, UTF8("i2nclip/chain/sign/1\n") || body_bytes)
record    = MessagePack([body_bytes, signature])
hash      = SHA256(UTF8("i2nclip/chain/block/1\n") || record)
```

`sequence` is the parent sequence plus one. `effects` holds at most one storage
effect (`publish`, `commit` or `purge`, as in blockchain storage). Each block has a
fresh 32-byte public salt and 12-byte nonce. Its AES-256-GCM key is
HKDF-SHA256 of the encryption root with that salt and info
`MessagePack(["i2nclip/chain/key/1", library_id])`; AAD is
`UTF8("i2nclip/chain/aad/1\n") || MessagePack(body without ciphertext)`.
The plaintext is one private [file operation](#file-operations). File and object
keys are random and carried in encrypted references.

The server checks signatures against the registered genesis key, exact parent,
public effects, inventories, quotas and blob addresses, but never materializes
private operations. Clients verify and decrypt every block before updating
materialized state. Hash-chain validity alone does not prove freshness: clients
never accept a head below their trusted checkpoint, and invalid input never
advances it.

Limits: 64 KiB per record; pages of at most 128 records and 1 MiB; blobs of
4 MiB + 64 bytes; at most 256 files per purge.

## HTTP API

| Endpoint | Authentication and purpose |
| --- | --- |
| `GET /api/health` | Public health response |
| `GET /api/ping` | Registered library proof; `204`, or `401` when not registered |
| `POST /api/register-key` | `[invitation, genesis]` signed by the genesis key; creates the library |
| `GET /api/blocks?after=<hash>&until=<hash>` | Bounded canonical pages after a known hash, optionally up to a fixed target |
| `POST /api/blocks` | Signed record with an exact parent; storage effects checked atomically |
| `POST /api/blobs` | Fixed `[fileID, ciphertext]` frame; stages a hash-addressed encrypted object |
| `GET /api/blobs/<fileID>/<ciphertextHash>` | Immutable ciphertext of a committed object |
| `GET /api/quota` | Current usage and limits |
| `/api/pairings/...` | Short-lived OPAQUE relay; creation requires the library, participants use scoped capabilities |

Request signatures cover origin, method, exact target, timestamp, nonce and body
hash, and are checked before bodies are read. All routes except health,
registration and pairing participation require a registered library before
nonce or transfer admission. Any authentication failure returns a generic `401`.
Registration has four isolated, non-queuing slots; an invalid registration
spends neither a nonce nor an invitation, and the nonce and the new library
commit atomically. Repeating the exact registration of an existing library
succeeds without consuming another invitation.

## Credentials

Credential plaintext is `[1, server_origin, genesis, seed, [trusted_sequence, trusted_hash]]`
(at most 1 MiB). It is sealed in three ways:

- **Local**: AES-256-GCM `[1, iv, ciphertext]` under the master-password
  wrapping key (PBKDF2-SHA256, 600,000 iterations) with AAD
  `i2nclip/local-library/1`. The IndexedDB session record also keeps a
  registration-pending flag for a prepared library not yet registered.
- **Backup**: `["i2nclip-library-backup", 2, [1, iv, ciphertext]]`, AES-256-GCM
  with AAD `i2nclip/library-backup/2`; files are capped at 1 MiB. The generated
  password is 32 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (160 bits),
  shown in groups of four joined by `-`. Input is uppercased and stripped of
  whitespace and `-`; the key is HKDF-SHA-256 of the normalized UTF-8 password
  with an empty salt and info `i2nclip/library-backup/2`. A random password needs
  no slow KDF; see [backup and purge format](backup-and-purge-format.md). A backup contains
  credentials only, not library data. Creation registers only after the backup is
  downloaded. Restoring a backup verifies history from its checkpoint before
  activation; a genesis-checkpoint backup answered by `401` becomes a prepared
  library that requires a fresh backup download before registration.
- **Pairing**: see below.

## Pairing transfer

Pairing codes are `XXXX-XXXX-XXXX`: a four-character room ID and a 40-bit
secret, never sent to the server. The context is
`i2nclip/pairing/v1 <origin> <room> <instance>`. Relay steps:

1. receiver OPAQUE initiation (join)
2. sender OPAQUE response
3. receiver OPAQUE finish
4. sender `[1, credentials, challenge]`, encrypted with AAD `<context> transfer 4`
5. receiver `[1, challenge]`, encrypted with the acknowledgment key

Both browsers display a verification code derived from the session key; the
sender must approve matching codes before step 4. The receiver persists and
verifies the credentials through the supplied checkpoint before acknowledging.
Pairing performs no chain writes and creates no receiver identity. Cancellation
cannot retract delivered credentials, and a lost acknowledgment can leave the
receiver connected. Relay limits are below.

### Relay

The server keeps at most 256 rooms in memory, one active room per library and
five creations per library per minute. Rooms expire 120 seconds after creation;
a restart abandons them, and multiple server processes need sticky routing.

Anonymous joins allow ten requests per TCP peer IP and 120 globally per rolling
minute. Failed participant requests (bad capability or missing room) spend the
same budget, so participant endpoints cannot enumerate rooms. Rejections return
`429` with `Retry-After: 60` before reading a body. The source is the TCP peer;
`Forwarded` and `X-Forwarded-For` are ignored, so clients behind a proxy share
its budget. Join and submission bodies share sixteen read slots; saturation
returns `503` without queueing. Bodies have a ten-second deadline.

| Endpoint | Authorization | Payload/result |
| --- | --- | --- |
| `POST /api/pairings` | Signed request from the registered library | `[1]`; creates a room, returns the sender capability |
| `POST /api/pairings/{id}/join` | None; first receiver wins | `[message]`; returns the receiver capability |
| `GET /api/pairings/{id}/messages` | Participant capability | Current snapshot |
| `POST /api/pairings/{id}/messages` | Participant capability | `[step, message]` |
| `DELETE /api/pairings/{id}` | Participant capability | Cancels the room; `204` |

Snapshots are `[1, id, instance, remaining_secs, step, last_message, capability]`;
only create and join return a capability, a random 256-bit bearer token. Only the
expected participant may submit each step; identical repeats are idempotent and
replacements or skipped steps are rejected. Messages are capped at 8 KiB, except
the 1 MiB credential transfer in step 4. Clients poll once per second, retry a
lost poll or submission once with the exact message, and never start a second
PAKE attempt with the same code.

## File operations

A block's encrypted plaintext is `[unix_ms, operation]`: the signing client's
clock in non-negative Unix milliseconds, for display only (devices may disagree,
so no ordering is enforced), and the operation. An object reference is
`[ciphertext_hash, raw_object_key]`. Operations are positional arrays:

```text
["AddFile", file_id, manifest_reference, metadata_reference]
["ReplaceMetadata", file_id, metadata_reference]
["DeleteFile", file_id]
["RestoreFile", file_id]
["PurgeFile", file_id]
```

`AddFile` requires a never-used file ID. `ReplaceMetadata` and `DeleteFile`
require a live file; `RestoreFile` and `PurgeFile` require a deleted, unpurged
file. Purge is irreversible. Operations carry complete metadata documents, not
patches. Materialized state keeps each file's creation sequence, manifest
reference, latest metadata reference, and deleted/purged flags; default order is
creation sequence descending. Replay never downloads objects, and a purged
object's absence is expected.

A client appends against the current verified head. Each mutation may carry a
precondition checked against that state (a metadata edit requires the file's
metadata to be unchanged; lifecycle changes require the matching state), and a
lost parent race is retried; see [rebased mutations](rebased-mutations.md).

## Storage effects

```text
["publish", file_id, inventory_digest]
["commit", file_id, sorted_unique_new_blob_hashes]   (at most two)
["purge", file_id]
```

`AddFile` pairs with `publish`, `ReplaceMetadata` with `commit` naming its new
metadata and optional thumbnail blob, and `PurgeFile` with `purge` for the same
ID. Delete and restore carry no effect. Clients reject any mismatch.

The inventory digest is SHA-256 of MessagePack
`["i2nclip/inventory/1", library_id, file_id, entries]`, where `entries` is every
staged `[hash, ciphertext_length]` for the file sorted by raw hash. The publisher
computes it; the server recomputes it from staged blobs in the append transaction,
so the chunk-hash list stays out of the chain. Effects reveal publication,
commitment and purge relationships, sizes and access patterns; names, tags,
thumbnails and edit/delete/restore types stay private.

## Encrypted file objects

Content chunks, manifests, metadata versions and thumbnails are blobs addressed
by SHA-256 of their exact bytes within one library and file, at most
4 MiB + 64 bytes each, with no cross-file deduplication.

Manifests, metadata and thumbnails each use a fresh random AES-256-GCM key and
nonce: envelope `[1, nonce, ciphertext]`, AAD MessagePack
`["i2nclip/object/1", library_id, file_id, purpose]` with purpose `manifest`,
`metadata` or `thumbnail`.

- Manifest: `[1, plaintext_size, 4194304, chunk_count, raw_content_key,
  ordered_chunk_hashes]`, at most 4 MiB, sized before reading the source.
- Metadata: `[1, attributes_map, thumbnail_reference_or_null]`, at most 64 KiB.
  Tags keep their first spelling and deduplicate by protocol normalization.
- Content: a fresh file ID and key per upload; chunk `i` uses a 12-byte IV with
  `i` as a big-endian integer in its last eight bytes, and AAD
  `"i2nclip/v2 chunk\n<file_id>\n<i>\n<chunk_count>\n<size>\n"`. Clients check
  the chunk hash and length and authenticate the complete chunk before exposing
  plaintext.

## Server storage and quotas

PostgreSQL holds libraries (genesis, head, limits, counters), immutable blocks,
file lifecycle rows (`staging`, `retained`, `purged`), blobs, invitations and
nonces; `sql/001_init.sql` enforces the shapes and immutability with constraints
and triggers. Purged files remain as tombstones so IDs are never reused.

Quota counts staged and retained ciphertext, including every metadata and
thumbnail version. A file slot is reserved at first staging; deletion does not
free it, purge and staging expiry do. Block history is reported separately and is
not limited. Uncommitted uploads expire after 24 hours without new bytes;
committed objects are never collected automatically. Appends, staging, purge and
maintenance serialize on the library row.

Transfers admit one upload and two downloads per library, and four uploads and
sixteen downloads globally, within 30 seconds. Defaults are 512 MiB and 10,000
files per library; operators change them with `i2nclip key set-limits`.

## Threat model

- **Any holder of the seed has full, permanent authority.** There is no
  revocation: a lost browser or leaked backup with its password keeps access.
  Moving to a new library is the only remedy.
- **Authorized writers are trusted.** A writer can delete data, grow the
  unbounded block history, or append a signed but undecryptable operation that
  stops replay for every client.
- **The server is untrusted** for confidentiality and integrity: clients verify
  every block and object. It can deny service or withhold a newer suffix that a
  client has never seen; clients never accept a head below their checkpoint.
- **Delivered code is trusted.** The server that serves the web app can serve
  malicious JavaScript, and any same-origin script can use an unlocked session.
  The [content security policy](content-security-policy.md) limits injection; it
  cannot protect against the serving origin itself.
- **Local protection** is the master password (PBKDF2-SHA256, 600,000
  iterations); a copied browser profile allows offline guessing.
- **Pairing availability** is best effort. A global join limit bounds
  room-ID guessing, so a flood of joins can delay pairing, and the first joiner
  occupies a room; OPAQUE and the verification codes still protect the transfer.
- **Purge** removes stored objects but cannot prove erasure from backups,
  caches, or copies on other browsers.
