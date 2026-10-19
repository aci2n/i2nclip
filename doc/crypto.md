# Cryptography and security boundaries

The browser implements client cryptography in `client/src/lib/protocol/crypto.ts`. Rust `src/crypto.rs` contains only server verification, hashing, sealed-blob shape checks, and supporting encoding/time helpers. Test-only `src/reference_crypto.rs` implements identities, encryption/decryption, tag derivation, and request signing for protocol fixtures and integration tests. Its AES-GCM, HKDF, HMAC, and Unicode normalization dependencies are dev dependencies. Shared vectors in `client/tests/test-vectors.json` check byte-for-byte agreement; the production server does not compile the reference helpers.

## Identity and keys

A private-key document is a MessagePack map `{v: 1, seed: bin, public_key: bin}`. The seed and public key are each 32 raw bytes. The containing identity is `{server_url: string, private_key: key-document}`. Key loading copies owned buffers before wiping temporary seeds. The seed is a randomly generated Ed25519 secret seed, not a password. The public key is derived from it. The browser checks their correspondence by signing and verifying a fixed probe message when loading the identity. The unlocked session retains non-extractable signing, HKDF, tag-label encryption and tag-token keys for API calls; lock/disposal releases their references.

The same seed is the input key material for HKDF-SHA256:

```text
PRK = HKDF-Extract(salt = UTF8("i2nclip"), IKM = seed)
K_meta(id) = HKDF-Expand(PRK, UTF8("i2nclip/keys/v1/metadata/" + id), 32)
K_desc(id) = HKDF-Expand(PRK, UTF8("i2nclip/keys/v1/descriptor/" + id), 32)
K_label = HKDF-Expand(PRK, UTF8("i2nclip/keys/v1/tag-label"), 32)
K_token = HKDF-Expand(PRK, UTF8("i2nclip/keys/v1/tag-token"), 32)
```

File IDs must be exactly 64 lowercase hexadecimal characters. Purpose-specific
operations select the key context and AAD internally. The session retains a
non-extractable HKDF handle and derives non-extractable AES/HMAC keys directly
with WebCrypto `deriveKey`, without exporting raw derived keys. Temporary seed
and PKCS#8 buffers are wiped even on failure. There is no derived-key cache.

The signing key uses the seed directly through standard Ed25519 seed expansion.
Each upload has an independent content key wrapped by its file's descriptor key.
There is no key rotation, forward secrecy, or independent recovery of signing and
encryption capability. Losing the seed loses access; exposing it compromises all
uses, including previously stored ciphertext. The session HKDF handle can derive
all file keys; non-extractability does not isolate them from compromised client
code. Public-key disclosure does not reveal secret keys.

Only this key schedule is supported. Existing version fields and identity/recovery
formats are unchanged, but old ciphertext and tag indexes are incompatible.
Restoring an identity does not migrate data. Databases are never automatically
cleared and there are no compatibility readers.

## Content and metadata encryption

Descriptors and editable metadata use AES-256-GCM with `K_desc(id)` and
`K_meta(id)` respectively, independently
sampled random 12-byte IVs, full 16-byte tags, and the existing envelope:

```text
MessagePack({v: 1, iv: nonce[12] as bin, ct: ciphertext || authentication_tag[16] as bin})
descriptor AAD: UTF8("i2nclip/v2 descriptor " + file_id)
metadata AAD:   UTF8("i2nclip/v1 meta " + file_id)
```

The immutable descriptor plaintext is MessagePack
`{v: 2, key: bin[32], plaintext_bytes: integer, chunk_bytes: 4194304, chunk_count: integer}`.
Each upload attempt samples a new random file ID and 256-bit content key. IDs are
64 lowercase hexadecimal characters, independent of ciphertext. Unwrapped content
keys are imported nonextractably; temporary raw-key/plain descriptor buffers are
wiped. Metadata can change without replacing this descriptor.

Chunks contain raw AES-256-GCM ciphertext plus the 16-byte tag under the content
key. Their IV is four zero bytes followed by the zero-based unsigned chunk index
encoded as eight big-endian bytes. AAD is exactly:

```text
i2nclip/v2 chunk\nFILE_ID\nINDEX\nCHUNK_COUNT\nPLAINTEXT_BYTES\n
```

Numbers use canonical decimal text; `\n` is one LF, including the final LF.
Chunk count is `max(1, ceil(size/4194304))`. Every nonfinal plaintext chunk is
4 MiB; empty content has one empty chunk. File/key/position/dimension binding,
exact length checks and GCM authentication replace a complete-file hash check.
Authenticate each full chunk before exposing any of its plaintext. Never reuse an
ID/key pair for a restarted upload or encrypt new bytes at an existing position.

Each file and purpose has its own nonce collision domain. Metadata edits for
one file share that file's metadata key across all browsers restoring the same
identity; tag labels share a library-wide key. AAD does **not** make nonce reuse
safe. Random 96-bit nonces have approximate collision probability
`q(q-1)/2^97` after `q` encryptions under one key. NIST SP 800-38D §8.3 caps
invocations at `2^32` per key for this random-IV construction across devices;
this is an outer limit, not a recommended application target. There is no tracked
key-use budget or rotation procedure. See [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf).

Production envelope operations generate fresh nonces internally and expose no
nonce override. Rust's test-only reference helpers accept deterministic nonces;
JavaScript tests temporarily mock randomness with automatic cleanup. Public
fixture seeds, keys, and nonces must never be used for actual data.

Current metadata plaintext is one MessagePack map:

```text
{metadata: map, thumb: bin | null}
```

Typical fields are `name`, `content_type`, `size` (plaintext bytes), `tags`
(readable spellings), optional `source_url`, `source_title`, and `image` details.
Metadata remains extensible; unknown fields are preserved. The thumbnail is raw
WebP bytes or null. A nested `thumb` property is removed. The decoder validates
the document shape and rejects trailing data. The conservative plaintext budget
is `65,536 - 64 = 65,472` bytes. The client drops the thumbnail if necessary;
metadata alone can still exceed the server cap. Shared vectors cover this
MessagePack plaintext, its envelope, and the complete upload document.

## Searchable tags

```text
normalized = lowercase(NFC(trim(tag)))
token = b64url(HMAC-SHA256(K_token, UTF8("tag\n" + normalized)))
```

Readable tag labels use AES-256-GCM with `K_label`, fresh 12-byte nonces, and
AAD UTF8("i2nclip/v1 tag " + token). Opening a label checks that its normalized
text reproduces the supplied token. Labels are separate from per-file metadata,
which also contains readable tags.

Normalization rejects empty output, more than 64 Unicode scalar values, commas, CR, and LF. It is lowercase conversion, not full Unicode case folding, and NFC happens before lowercasing. Rust and JavaScript use their runtime Unicode and whitespace rules; they are not identical for every possible character. A client should preserve the first readable spelling when deduplicating normalized tags.

The server stores tokens for equality matching and AND queries. Without `K_token`, it cannot directly enumerate a dictionary of candidate tags. It still learns repetition, frequencies, tag co-occurrence, query/access patterns, and relationships within a library. Reusing the same seed on different servers produces the same tokens and public key, allowing correlation. A server can alter the token index or omit results; the GCM tag does not authenticate that index or the completeness of a list.

## Signed requests

Requests use ordinary Ed25519, not Ed25519ph. SHA-256 hashes the body as a field of the signed envelope; the signature authenticates the complete textual envelope specified in [protocol.md](protocol.md). Method, exact target, configured origin, timestamp, nonce, and body digest are covered. Nonces plus the clock window prevent normal repeated execution of captured headers. The server uses dalek's `verify_strict` to reject weak public keys and low-order signature points. Registration uses the authenticated signer as the enrolled key and skips only the registered-key lookup. Its body contains only the invitation code. The invitation authorizes enrollment; the signature proves possession and binds the request. A stolen invitation can still authorize an attacker’s own key. Existing weak-key database rows remain stored but cannot authenticate. These checks preserve normal generated-key signatures and the existing wire format; they do not assert full prime-order subgroup validation beyond dalek's documented rules.

The digest comparison need not hide the digest: body hashes and signatures are transmitted public values. This is not a secret password/HMAC comparison. Signature verification itself is delegated to the cryptographic library.

## Saved identity and recovery (client-side)

PBKDF2-HMAC-SHA256 derives a non-extractable 256-bit AES-GCM key from exact UTF-8 master-password bytes, a fresh 16-byte salt, and 600,000 iterations. One atomic base64-wrapped MessagePack localStorage record holds the salt, iteration count, and encrypted single identity. Encryption uses a fresh 12-byte IV, a full GCM tag, and AAD `i2nclip/local-identity/1`. Password changes verify the old password and encrypt a replacement record with a fresh salt and IV. No passwords, upload sources, or workflow state are saved.

The downloaded `i2nclip-recovery.msgpack` file contains the MessagePack map `{format: "i2nclip-recovery", v: 1, encrypted: ...}`. Password envelopes store `v`, binary `iv`, binary `ct`, binary `salt`, and `iterations`. Its independent password protects the server URL and identity document using AAD `i2nclip/recovery/1`. Recovery derives its own key and salt. Imports validate the identity and encrypt it under the destination client's master-password key. Recovery readers enforce 600,000–2,000,000 PBKDF2 iterations and a one-MiB file limit. Recovery files keep their password after a master-password change. This greenfield project provides no format migration.

Passwords and library seeds never reach the server. Encryption at rest does not protect an unlocked client from compromised application code. JavaScript strings and browser-managed memory cannot be reliably overwritten; locking releases references, cancels work, and prevents stale results from re-entering the application.

## Guarantees and exclusions

The server cannot decrypt content, filenames, readable tags, or thumbnails using its stored public keys. It observes owners, random IDs, ciphertext lengths, upload times, tag equality and access patterns. There is no size padding. Server-side `looks_sealed` only checks framing; it cannot prove that a submitted blob is encrypted.

GCM detects modified ciphertext and wrong keys/purposes/positions; descriptor AAD binds the content key and dimensions to the file ID. An old valid metadata blob for the same file ID still authenticates, so metadata rollback remains possible. The protocol has no authenticated revision counter, rollback detection, list completeness proof, or binding of server `created_at`/`bytes` fields and search tokens to the current encrypted metadata. TLS authenticates the transport endpoint and protects registration codes, metadata traffic patterns on the wire, and responses from network attackers. Encryption and request signatures do not replace TLS or make a malicious server honest.
