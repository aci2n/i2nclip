# Cryptography and security boundaries

## Identity and keys

A library identity is JSON `{ "v": 1, "seed": "…", "publicKey": "…" }`. The seed and public key are each 32 bytes encoded as canonical unpadded base64url. The seed is a randomly generated Ed25519 secret seed, not a password. The public key is derived from it. The browser checks their correspondence by signing and verifying a fixed probe message when loading the identity.

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
0x01 || nonce[12] || ciphertext || authentication_tag[16]
```

The overhead is exactly 29 bytes, including empty plaintext. Rust uses `aes-gcm`; the browser uses WebCrypto. The associated data is exactly:

```text
content:  UTF8("i2nclip/v1 content " + canonical_uuid)
metadata: UTF8("i2nclip/v1 meta " + canonical_uuid)
```

No newline or NUL is appended. Associated data is authenticated but not stored in the blob. It binds ciphertext to a UUID and purpose, preventing content/metadata substitution and swapping between different IDs. The version byte is checked by the decoder; the version/purpose are also represented in the AAD. Decryption authenticates before returning plaintext.

Every encryption under this library key shares one nonce collision domain, including metadata edits, content uploads, and all browsers restoring the same identity. AAD does **not** make nonce reuse safe. Random 96-bit nonces have approximate collision probability `q(q-1)/2^97` after `q` encryptions. NIST SP 800-38D §8.3 caps invocations at `2^32` per key for this random-IV construction across devices; this is an outer limit, not a recommended application target. The project has no tracked key-use budget or rotation procedure. See [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf).

Production paths generate fresh nonces. Rust's exported `encrypt_with_nonce` and JavaScript's optional nonce parameter exist for deterministic tests and permit unsafe reuse by callers. The shared fixture reuses a test key/nonce across content and metadata; those public fixture values must never be used for actual data.

Current metadata plaintext is:

```text
uint32be(JSON byte length) || UTF8(JSON)
uint32be(thumbnail byte length) || raw WebP thumbnail
```

Typical JSON fields are `name`, `content_type`, `size` (plaintext bytes), `tags` (readable spellings), and optional `image` details. A zero-length thumbnail means none. The client strips a `thumb` JSON property and rejects trailing bytes when decoding. The maximum complete plaintext is `65,536 - 29 = 65,507` bytes. It drops the thumbnail if necessary; oversized JSON alone can still cause server rejection. The server treats this plaintext structure as opaque. The shared metadata crypto vector predates this structure and encrypts raw JSON; it validates the cipher/AAD rather than the current metadata payload format.

## Searchable tags

```text
normalized = lowercase(NFC(trim(tag)))
token = b64url(HMAC-SHA256(K_tag, UTF8("tag\n" + normalized)))
```

Normalization rejects empty output, more than 64 Unicode scalar values, commas, CR, and LF. It is lowercase conversion, not full Unicode case folding, and NFC happens before lowercasing. Rust and JavaScript use their runtime Unicode and whitespace rules; they are not identical for every possible character. A client should preserve the first readable spelling when deduplicating normalized tags.

The server stores tokens for equality matching and AND queries. Without `K_tag`, it cannot directly enumerate a dictionary of candidate tags. It still learns repetition, frequencies, tag co-occurrence, query/access patterns, and relationships within a library. Reusing the same seed on different servers produces the same tokens and public key, allowing correlation. A server can alter the token index or omit results; the GCM tag does not authenticate that index or the completeness of a list.

## Signed requests

Requests use ordinary Ed25519, not Ed25519ph. SHA-256 hashes the body as a field of the signed envelope; the signature authenticates the complete textual envelope specified in [protocol.md](protocol.md). Method, exact target, configured origin, timestamp, nonce, and body digest are covered. Nonces plus the clock window prevent normal repeated execution of captured headers. The server uses dalek's `verify_strict` to reject weak public keys and low-order signature points. Registration also parses the point and rejects `is_weak()` before consuming an invitation. Existing weak-key database rows remain stored but cannot authenticate. These checks preserve normal generated-key signatures and the existing wire format; they do not assert full prime-order subgroup validation beyond dalek's documented rules.

The digest comparison need not hide the digest: body hashes and signatures are transmitted public values. This is not a secret password/HMAC comparison. Signature verification itself is delegated to the cryptographic library.

## Password wrapping and recovery (client-side)

The browser encrypts the identity document before persistent storage or recovery export. PBKDF2-HMAC-SHA256 derives an AES-256-GCM key from exact UTF-8 password bytes with a fresh 16-byte salt and 600,000 iterations by default. Wrapping uses a fresh 12-byte IV, full GCM tag, and no AAD. The wrapped JSON contains `v`, `iterations`, `salt`, `iv`, and `ct`; binary values here use standard padded base64. Import accepts iteration counts from 1 through 2,000,000, so the default strength is not an enforced minimum for imported files.

A recovery file wraps that object in `{ "format": "i2nclip-recovery", "v": 1, "serverUrl": "…", "wrappedKey": … }`. The outer server URL is not authenticated by GCM. Wrong passwords or modified ciphertext fail authentication. Anyone with the recovery file can guess passwords offline; a high-entropy password matters even with the default work factor. Neither password nor seed is sent to the server. The unlocked seed is available to client code/session storage; wrapping does not protect against compromise of an unlocked browser or extension.

## Guarantees and exclusions

The server cannot decrypt content, filenames, readable tags, or thumbnails using its stored public keys. It observes owners, UUIDs, ciphertext lengths, upload times, tag equality and access patterns. There is no size padding. Server-side `looks_sealed` only checks framing; it cannot prove that a submitted blob is encrypted.

GCM detects modified ciphertext and wrong IDs/purposes, but an old valid blob for the same UUID/purpose still authenticates. The protocol has no authenticated revision counter, rollback detection, list completeness proof, or binding of server `created_at`/`bytes` fields and search tokens to the current encrypted metadata. TLS authenticates the transport endpoint and protects registration codes, metadata traffic patterns on the wire, and responses from network attackers. Encryption and request signatures do not replace TLS or make a malicious server honest.

This review did not identify a practical seed-recovery or ciphertext-forgery attack against normally generated keys and fresh nonces. It is a source review with focused tests, not a formal cryptographic audit or dependency vulnerability scan.
