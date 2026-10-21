# Current protocol

The normative wire formats, validation rules, limits, and lifecycle are specified
in [blockchain storage](blockchain-storage.md) and [offline recovery](library-recovery.md).
The pre-chain media/tag protocol has been removed; there are no compatibility readers.

| Endpoint | Authentication and purpose |
| --- | --- |
| `GET /api/health` | Public health response |
| `GET /api/ping` | Active device proof; empty body |
| `POST /api/register-key` | New device proof and invitation; canonical genesis and recovery-signed enrollment block 1 |
| `GET /api/blocks?after=<hash>&until=<hash>` | Active device or fixed recovery principal; bounded canonical pages, required `after`, optional fixed target `until` |
| `POST /api/blocks` | Signed canonical record with an exact parent; authority and storage effects checked atomically |
| `POST /api/blobs` | Active device; fixed `[fileID, ciphertext]` frame; stages a hash-addressed encrypted object |
| `GET /api/blobs/<fileID>/<ciphertextHash>` | Active device; immutable ciphertext, membership rechecked on the server |
| `GET /api/quota` | Active device; current operational usage and limits |
| `/api/pairings/...` | Bounded short-lived OPAQUE relay; creation requires an active device, participant requests use scoped capabilities |

Fixed structures use positional MessagePack arrays. Only extensible encrypted
metadata uses a map. Signatures cover exact bytes, origin, method, path/query,
timestamp, nonce, and body hash. Request proofs are checked before reading bodies;
nonces reject replay and early data is forbidden. Block signatures are separate
from HTTP proofs. A recovery-signed reset can be submitted without an authorized
device and atomically chooses a fresh initial device.

The server never materializes private file operations. It checks public chain
position, device/root authority, opaque storage effects, inventories, quotas,
and immutable blob addresses. Clients independently verify and decrypt every
accepted operation before updating materialized state. Hash-chain validity alone
does not prove freshness: local trusted-head pins and pairing checkpoints are
required. No endpoint grants read access to plaintext.
