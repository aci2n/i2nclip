# Current protocol

This document and the [shared-seed contract](shared-seed/README.md) are the
current wire and credential specification. [Blockchain storage](blockchain-storage.md)
remains the reference for encrypted file objects, file operations, storage
effects, inventories, quotas and purge where it does not conflict; its device
membership, epoch, enrollment, recovery and rotation sections are superseded.
There are no compatibility readers.

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
The plaintext is one private file operation (`AddFile`, `ReplaceMetadata`,
`DeleteFile`, `RestoreFile`, `PurgeFiles`). File and object keys are random
and carried in encrypted references.

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
- **Backup**: `["i2nclip-library-backup", 1, [1, salt, iterations, iv, ciphertext]]`
  under a generated 256-bit base64url password with AAD
  `i2nclip/library-backup/1`; files are capped at 1 MiB. A backup contains
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
receiver connected. Relay limits and rate limits are unchanged from
[device pairing](pairing.md#relay-api).
