# Cryptography and security boundaries

The browser implements client cryptography in `client/src/lib/protocol/crypto.js`. Rust `src/crypto.rs` contains only server verification, hashing, sealed-blob shape checks, and supporting encoding/time helpers. Test-only `src/reference_crypto.rs` implements identities, encryption/decryption, tag derivation, and request signing for protocol fixtures and integration tests. Its AES-GCM, HKDF, HMAC, and Unicode normalization dependencies are dev dependencies. Shared vectors in `client/tests/test-vectors.json` check byte-for-byte agreement; the production server does not compile the reference helpers.

## Identity and keys

A private-key document is a MessagePack map `{v: 1, seed: bin, public_key: bin}`. The seed and public key are each 32 raw bytes. The containing identity is `{server_url: string, private_key: key-document}`. Key loading copies owned buffers before wiping temporary seeds. The seed is a randomly generated Ed25519 secret seed, not a password. The public key is derived from it. The browser checks their correspondence by signing and verifying a fixed probe message when loading the identity. The unlocked session retains non-extractable signing, encryption and tag keys for API calls; lock/disposal releases their references.

The same seed is the input key material for HKDF-SHA256:

```text
PRK   = HKDF-Extract(salt = UTF8("i2nclip"), IKM = seed)
K_enc = HKDF-Expand(PRK, info = UTF8("enc"), length = 32)
K_tag = HKDF-Expand(PRK, info = UTF8("tag"), length = 32)
```

These fixed labels separate encryption and search keys. The signing key uses the seed directly through standard Ed25519 seed expansion. There is no per-file key, key rotation, forward secrecy, or independent recovery of signing/encryption capability. Losing the seed loses access; exposing it compromises all three uses, including previously stored ciphertext. Public-key disclosure does not reveal these secret keys.

## Content and metadata encryption

Both use AES-256-GCM with `K_enc`, independently sampled 12-byte CSPRNG nonces, and full 16-byte authentication tags:

```text
MessagePack({v: 1, iv: nonce[12] as bin, ct: ciphertext || authentication_tag[16] as bin})
```

The encoded overhead is 42–45 bytes, depending on the ciphertext length prefix. Rust uses `aes-gcm`; the browser uses WebCrypto. The associated data is exactly:

```text
content:  UTF8("i2nclip/v1 content")
metadata: UTF8("i2nclip/v1 meta " + ciphertext_sha256)
```

No newline or NUL is appended. Associated data is authenticated but not stored in the blob. Content uses fixed purpose AAD to avoid a circular dependency between its ciphertext and its hash. Its AAD does not include the owner public key: content encryption already uses `K_enc` derived from that owner's secret seed, so another identity has a different key. The server cannot verify the GCM tag and therefore cannot use this AAD to enforce ownership at upload time.

The complete sealed content (version, nonce, ciphertext, tag) is hashed using SHA-256 to form its 64-character lowercase hexadecimal identifier. Clients compare this hash against the requested URL before decrypting. Metadata AAD includes that hash, binding metadata to the exact content and preventing metadata swaps between hashes. Distinct purpose labels prevent content/metadata substitution. The version field is checked by the decoder; the version/purpose are also represented in the AAD. Decryption authenticates before returning plaintext.

Every encryption under this library key shares one nonce collision domain, including metadata edits, content uploads, and all browsers restoring the same identity. AAD does **not** make nonce reuse safe. Random 96-bit nonces have approximate collision probability `q(q-1)/2^97` after `q` encryptions. NIST SP 800-38D §8.3 caps invocations at `2^32` per key for this random-IV construction across devices; this is an outer limit, not a recommended application target. The project has no tracked key-use budget or rotation procedure. See [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf).

Production paths generate fresh nonces. Rust's test-only `encrypt_with_nonce` and JavaScript's optional nonce parameter exist for deterministic tests and permit unsafe reuse by callers. The shared fixture reuses a test key/nonce across content and metadata; those public fixture values must never be used for actual data.

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
token = b64url(HMAC-SHA256(K_tag, UTF8("tag\n" + normalized)))
```

Normalization rejects empty output, more than 64 Unicode scalar values, commas, CR, and LF. It is lowercase conversion, not full Unicode case folding, and NFC happens before lowercasing. Rust and JavaScript use their runtime Unicode and whitespace rules; they are not identical for every possible character. A client should preserve the first readable spelling when deduplicating normalized tags.

The server stores tokens for equality matching and AND queries. Without `K_tag`, it cannot directly enumerate a dictionary of candidate tags. It still learns repetition, frequencies, tag co-occurrence, query/access patterns, and relationships within a library. Reusing the same seed on different servers produces the same tokens and public key, allowing correlation. A server can alter the token index or omit results; the GCM tag does not authenticate that index or the completeness of a list.

## Signed requests

Requests use ordinary Ed25519, not Ed25519ph. SHA-256 hashes the body as a field of the signed envelope; the signature authenticates the complete textual envelope specified in [protocol.md](protocol.md). Method, exact target, configured origin, timestamp, nonce, and body digest are covered. Nonces plus the clock window prevent normal repeated execution of captured headers. The server uses dalek's `verify_strict` to reject weak public keys and low-order signature points. Registration also parses the point and rejects `is_weak()` before consuming an invitation. It requires the same signed envelope using the registering key, binds the payload public key to that signer, and skips only the registered-key lookup. The invitation authorizes enrollment; the signature proves possession and binds the request. A stolen invitation can still authorize an attacker’s own key. Existing weak-key database rows remain stored but cannot authenticate. These checks preserve normal generated-key signatures and the existing wire format; they do not assert full prime-order subgroup validation beyond dalek's documented rules.

The digest comparison need not hide the digest: body hashes and signatures are transmitted public values. This is not a secret password/HMAC comparison. Signature verification itself is delegated to the cryptographic library.

## Saved identity and recovery (client-side)

PBKDF2-HMAC-SHA256 derives a non-extractable 256-bit AES-GCM key from exact UTF-8 master-password bytes, a fresh 16-byte salt, and 600,000 iterations. One atomic base64-wrapped MessagePack localStorage record holds the salt, iteration count, and encrypted single identity. Encryption uses a fresh 12-byte IV, a full GCM tag, and AAD `i2nclip/local-identity/1`. Password changes verify the old password and encrypt a replacement record with a fresh salt and IV. No passwords, upload sources, or workflow state are saved.

The downloaded `i2nclip-recovery.msgpack` file contains the MessagePack map `{format: "i2nclip-recovery", v: 1, encrypted: ...}`. Password envelopes store `v`, binary `iv`, binary `ct`, binary `salt`, and `iterations`. Its independent password protects the server URL and identity document using AAD `i2nclip/recovery/1`. Recovery derives its own key and salt. Imports validate the identity and encrypt it under the destination client's master-password key. Recovery readers enforce 600,000–2,000,000 PBKDF2 iterations and a one-MiB file limit. Recovery files keep their password after a master-password change. This greenfield project provides no format migration.

Passwords and library seeds never reach the server. Encryption at rest does not protect an unlocked client from compromised application code. JavaScript strings and browser-managed memory cannot be reliably overwritten; locking releases references, cancels work, and prevents stale results from re-entering the application.

## Guarantees and exclusions

The server cannot decrypt content, filenames, readable tags, or thumbnails using its stored public keys. It observes owners, ciphertext hashes, ciphertext lengths, upload times, tag equality and access patterns. There is no size padding. Server-side `looks_sealed` only checks framing; it cannot prove that a submitted blob is encrypted.

GCM detects modified ciphertext and wrong keys/purposes; the content hash check additionally ties bytes to the requested URL. An old valid metadata blob for the same content hash still authenticates, so metadata rollback remains possible. The protocol has no authenticated revision counter, rollback detection, list completeness proof, or binding of server `created_at`/`bytes` fields and search tokens to the current encrypted metadata. TLS authenticates the transport endpoint and protects registration codes, metadata traffic patterns on the wire, and responses from network attackers. Encryption and request signatures do not replace TLS or make a malicious server honest.
