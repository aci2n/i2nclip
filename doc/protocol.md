# Protocol v1

The API uses HTTP, JSON responses, two small binary request frames, and an application-defined Ed25519 authentication envelope. There is no custom transport, handshake, session token, or cryptographic primitive. TLS terminates at the deployment's reverse proxy. API paths start at the origin root; deployment under a path prefix is unsupported.

## Encodings and identity

`b64url` means URL-safe base64 without padding. Public keys are raw 32-byte Ed25519 keys (43 encoded characters); signatures are 64 bytes (86 characters). Body digests are 64 lowercase hexadecimal characters. Item identifiers (`id`) are the SHA-256 of the complete sealed content blob, encoded as 64 lowercase hexadecimal characters. The server computes them independently. Hashes are globally unique across owners while rows or blob files exist; an existing hash returns `409`. There are no UUIDs or caller-chosen content identifiers.

The client generates its identity locally. The server registers only the public key. Registration requires canonical base64url encoding, a point accepted by dalek's `VerifyingKey::from_bytes`, and a key that is not weak (`is_weak()` is false). Invalid or weak keys return `400` before consuming an invitation. An administrator issues a one-time registration code using `i2nclip otc issue`. The code contains 16 random bytes encoded as b64url and defaults to a 24-hour lifetime. SQLite stores SHA-256 of the trimmed code. Registration consumes an unexpired code and inserts the public key in one immediate transaction. An already registered key still requires a fresh valid code; `INSERT OR IGNORE` prevents a duplicate key error. Registration does not prove possession of the private key.

## Endpoints

| Method and path | Authentication/body | Success |
| --- | --- | --- |
| `GET /api/health` | None | `200`, `{"ok":true}` |
| `POST /api/register-key` | No signature; JSON `{"otc":"…","public_key":"…"}` | `204` |
| `GET /api/media` | Signed; client sends no body | `200`, `{"media":[…],"next":null}` or a cursor |
| `POST /api/media` | Signed POST frame | `201`, one media object |
| `GET /api/media/{id}` | Signed; client sends no body | `200`, encrypted content bytes |
| `PUT /api/media/{id}` | Signed metadata frame | `200`, one media object |
| `DELETE /api/media/{id}` | Signed; client sends no body | `204` |

A media object contains `id`, `created_at` (server Unix seconds), `bytes` (encrypted content length), `tokens` (search fingerprints), and `meta` (encrypted metadata encoded using **standard padded base64**, not b64url).

List queries accept repeated `tag=TOKEN` parameters and optional `after=CREATED_AT.ID`. All distinct requested tags must match. Pages contain at most 24 items, ordered by creation time descending and hash ascending. `next` is the last returned item's cursor only when another row exists. Pagination is not a snapshot: intervening mutations may change results. Unknown query keys are ignored, empty token values are ignored, and the last repeated `after` wins. The hand-written parser does not percent-decode values; use the literal token/cursor alphabet.

Errors are JSON `{"error":"…"}`. Statuses include `400` for malformed data, `401` for failed authentication or replay, `403` for invalid/expired/spent registration codes, `404` for missing or unowned items, `408` for body-read timeouts, `409` for an existing sealed-content hash, `413` for oversized HTTP bodies, `503` when upload or download slots are occupied, and `500` for internal failures. Some field-size violations become `400` during frame validation. JSON and empty responses use `Cache-Control: no-store`. Content responses use `application/octet-stream` and `private, max-age=31536000, immutable`; a URL identifies immutable ciphertext. Cached copies may remain readable after deletion or authorization changes.

## Request authentication

Every media request supplies:

```text
Authorization: Bearer PUBLIC_KEY.TIMESTAMP.NONCE.BODY_HASH.SIGNATURE
```

`TIMESTAMP` is decimal Unix seconds. `NONCE` is 16 random bytes encoded as b64url. `BODY_HASH` is SHA-256 of the exact HTTP body bytes, including the frame prefixes; absent bodies hash as the empty byte string. The signature is plain Ed25519 over the UTF-8 bytes of:

```text
i2nclip-auth-v1\n
ORIGIN\n
TIMESTAMP\n
NONCE\n
METHOD\n
PATH_AND_QUERY\n
BODY_HASH\n
```

Here `\n` denotes one LF byte, including the final LF. There are no blank lines. `ORIGIN` is the server's configured public origin (`I2N_ORIGIN`), not the incoming Host header. The server parses it with the WHATWG-compatible `url` crate and serializes its origin to match the browser's `new URL(serverUrl).origin`: hostnames are normalized, internationalized domains use IDNA, IPv6 is serialized canonically, and default ports are omitted. Nondefault ports remain. Surrounding whitespace and an optional single root slash are accepted. Credentials, paths, queries, fragments, malformed ports, embedded whitespace/control characters, and URLs requiring slash/backslash repairs are rejected. Raw paths such as `/api/..` are rejected even if URL normalization would collapse them to `/`. `METHOD` is the actual HTTP method. `PATH_AND_QUERY` is the exact request target, including query ordering and percent encodings; proxies must preserve it. Timestamp parsing on the server reconstructs its canonical decimal representation for signing.

The server checks timestamp distance from its clock is at most 300 seconds, checks the public-key allow-list, verifies the signature with dalek's `verify_strict`, then records the nonce **before reading the body**. Strict verification rejects weak keys and low-order signature points, including keys stored before registration validation was strengthened. Rejected signatures neither read the body nor spend the nonce. It reads with a streaming size cap and verifies the body digest before performing the operation. Even an invalid body or malformed query spends the nonce after successful header authentication. Retries must use a new nonce and signature.

Nonces are globally unique in SQLite, rather than scoped by public key. A nonce expires at `signed_timestamp + 300`; cleanup deletes entries strictly older than the current time. Future-dated requests can therefore remain acceptable for almost ten minutes from first receipt. Persistence prevents ordinary restart replay; restoring an older database or rolling the clock backward can weaken that guarantee. A captured valid request can be raced before its first use; TLS remains necessary.

## Binary frames

`chunk(X)` is `uint32be(byte_length(X)) || X`. Every field must be present, including zero-length token text. Decoders reject truncation, excessive field lengths, invalid UTF-8 text, and trailing bytes.

```text
POST /api/media:
    chunk(encrypted_metadata)
    chunk(encrypted_content)
    chunk(UTF8(tokens joined by LF))

PUT /api/media/{id}:
    chunk(encrypted_metadata)
    chunk(UTF8(tokens joined by LF))
```

Token parsing trims lines, ignores empty lines, and removes duplicates. Each token must have 43 characters in `[A-Za-z0-9_-]`; the server does not decode it to check canonical base64. Maximum distinct tokens: 32. The server only checks encrypted blobs have version byte `0x01` and at least 29 bytes; it cannot verify GCM authentication without the client key.

| Limit | Bytes/count |
| --- | --- |
| Client plaintext file | 33,554,432 (32 MiB) |
| Server encrypted content | 33,554,496 (32 MiB + 64) |
| Encrypted metadata | 65,536 |
| Token text field | 4,096 |
| Total authenticated request body | 33,624,140 |
| Metadata PUT request body | 69,640 |
| Media GET/DELETE request body | 0 |
| Registration HTTP body | 4,096 |
| Registration code text | 512 |

The authenticated extractor selects byte caps by method: POST allows 33,624,140 bytes, PUT allows 69,640 bytes (two prefixes, encrypted metadata, and token text), and GET/DELETE require an empty body. Both the early Content-Length check and the streaming reader use that cap; missing or dishonest length headers cannot bypass the byte count. Nonempty GET/DELETE bodies return `413`. Authentication still happens before body reads and early size rejection, so authenticated oversized requests spend their nonce. Registration retains its separate 4,096-byte streaming cap. The server does not enforce request Content-Type. Upload and download admission each have two slots per router. There is no storage or account quota.

Complete body reads have total deadlines: 120 seconds for media POST, 30 seconds for PUT, and 10 seconds for media GET/DELETE and registration. The clock starts when body reading begins, after media authentication and early Content-Length checks, and never resets on chunks. Timeout drops the body and partial buffer and returns `408`, `{"error":"request body timed out"}`, with `Cache-Control: no-store`. Authentication nonces are already spent; timed-out registrations do not consume invitation codes. The deadline does not cover headers, authentication, subsequent hashing, or storage operations.

## Storage and retry semantics

SQLite holds registered keys, hashed registration codes, spent nonces, media rows, encrypted metadata, and tag tokens. Committed content lives in a flat `blobs/<ciphertext_sha256>` directory; incomplete uploads are staged separately in `staging/<ciphertext_sha256>`. Every media operation filters by the authenticated owner; knowing another owner's hash does not authorize a network download.

The client encrypts content with `UTF8("i2nclip/v1 content")` as AAD. This purpose label is fixed and contains no owner key; each owner's encryption key is already derived from that owner's secret seed. The server cannot verify the GCM tag and cannot enforce such a client-side binding. The client hashes the complete sealed blob (`0x01 || nonce[12] || ciphertext || tag[16]`) with SHA-256 and encodes the result as 64 lowercase hexadecimal characters. It then encrypts metadata using `UTF8("i2nclip/v1 meta " + hash)` as AAD. The POST frame contains only metadata, content, and token text. The server computes the content hash; it does not accept a client identifier. Content GETs check that the received sealed bytes hash to the requested identifier before decryption.

Storage uses `staged_files(id, created_at)` as a durable cleanup journal. Uploads reserve their hash before creating `staging/<hash>`, fsync the complete file, then rename it to `blobs/<hash>` under an immediate SQLite transaction. Both directories are synced before that transaction replaces the intent with the media row and tags. Existing live or pending hashes return `409`; existing destination files are never overwritten. No receipt replays success.

DELETE atomically replaces the media row with a cleanup intent before unlinking. The shared database mutex coordinates authorized download opening with deletion; an opened descriptor pins its bytes. SIGUSR1 requests GC in the running server. It waits for uploads, pauses upload admission, and removes expired intents and their files after seven days. Per-candidate immediate transactions recheck state, and directory syncs precede forgetting intents. There are no filesystem locks or separate GC process. Run one server per volume. See [gc.md](gc.md) for complete ordering, crash analysis, and the limits of the eventual-cleanup guarantee.

An exact sealed-payload retry gets `409` after success. The application prepares fresh ciphertext when a failed upload is retried, so re-encryption normally creates a new hash and another item. After a lost successful response, refresh the library before retrying to avoid creating another copy. No nonce reuse or cached replay body is introduced.

PUT atomically replaces encrypted metadata and search tokens; content and its hash do not change. DELETE removes the row and cascading tags, then unlinks/synchronizes the blob directory while retaining the exclusive lock. A deletion crash may leave an orphan; already opened downloads retain their original file. Different sealed content always uses a different URL, subject to SHA-256 collision resistance. This is a greenfield format: the initial schema and shared vectors are updated directly, with no migration or version bump.

Upload POSTs share two slots across owners in one server router. After authentication and early size checks, admission either succeeds immediately or returns `503`, `{"error":"uploads busy; try again"}`, `Retry-After: 1`, and `Cache-Control: no-store`, without reading the body. The nonce is spent, so retries require a new signature and nonce. Slots cover body reading, hashing, frame decoding, and storage, including blocking workers that outlive a cancelled request. Other endpoints do not consume upload slots.

Content GETs use two separate download slots per router, acquired after authentication and body verification. Saturation returns `503`, `{"error":"downloads busy; try again"}`, `Retry-After: 1`, and `Cache-Control: no-store`; retry with a new nonce/signature. File length must match the indexed ciphertext length and fit the sealed-content bounds; corruption returns `500` before headers, while missing/unowned content returns `404` when capacity is available. Successful responses stream at most 64 KiB per chunk with Content-Length, retaining the file handle and permit until completion or disposal. Files truncated during transmission cause a body error; files grown after opening cannot expand the response beyond its indexed length. Cache behavior is unchanged.
