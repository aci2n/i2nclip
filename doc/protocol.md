# Protocol v1

The API uses HTTP, JSON responses, two small binary request frames, and an application-defined Ed25519 authentication envelope. There is no custom transport, handshake, session token, or cryptographic primitive. TLS terminates at the deployment's reverse proxy. API paths start at the origin root; deployment under a path prefix is unsupported.

## Encodings and identity

`b64url` means URL-safe base64 without padding. Public keys are raw 32-byte Ed25519 keys (43 encoded characters); signatures are 64 bytes (86 characters). Body digests are 64 lowercase hexadecimal characters. Item IDs are canonical lowercase hyphenated UUID strings, 36 UTF-8 bytes. The server checks UUID syntax, but does not require UUID version 4. IDs are globally unique across owners while their rows exist.

The client generates its identity locally. The server registers only the public key. An administrator issues a one-time registration code using `i2nclip otc issue`. The code contains 16 random bytes encoded as b64url and defaults to a 24-hour lifetime. SQLite stores SHA-256 of the trimmed code. Registration consumes an unexpired code and inserts the public key in one immediate transaction. An already registered key still requires a fresh valid code; `INSERT OR IGNORE` prevents a duplicate key error. Registration does not prove possession of the private key.

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

List queries accept repeated `tag=TOKEN` parameters and optional `after=CREATED_AT.ID`. All distinct requested tags must match. Pages contain at most 24 items, ordered by creation time descending and UUID ascending. `next` is the last returned item's cursor only when another row exists. Pagination is not a snapshot: intervening mutations may change results. Unknown query keys are ignored, empty token values are ignored, and the last repeated `after` wins. The hand-written parser does not percent-decode values; use the literal token/cursor alphabet.

Errors are JSON `{"error":"…"}`. Statuses include `400` for malformed data, `401` for failed authentication or replay, `403` for invalid/expired/spent registration codes, `404` for missing or unowned items, `409` for conflicting IDs/payloads, `413` for oversized HTTP bodies, and `500` for internal failures. Some field-size violations become `400` during frame validation. JSON and empty responses use `Cache-Control: no-store`. Content responses use `application/octet-stream` and `private, max-age=31536000, immutable`; UUID reuse can invalidate that assumption (see review).

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

Here `\n` denotes one LF byte, including the final LF. There are no blank lines. `ORIGIN` is the server's configured public origin (`I2N_ORIGIN`), not the incoming Host header. The browser uses `new URL(serverUrl).origin`. `METHOD` is the actual HTTP method. `PATH_AND_QUERY` is the exact request target, including query ordering and percent encodings; proxies must preserve it. Timestamp parsing on the server reconstructs its canonical decimal representation for signing.

The server checks timestamp distance from its clock is at most 300 seconds, checks the public-key allow-list, verifies the signature, then records the nonce **before reading the body**. It reads with a streaming size cap and verifies the body digest before performing the operation. Even an invalid body or malformed query spends the nonce after successful header authentication. Retries must use a new nonce and signature.

Nonces are globally unique in SQLite, rather than scoped by public key. A nonce expires at `signed_timestamp + 300`; cleanup deletes entries strictly older than the current time. Future-dated requests can therefore remain acceptable for almost ten minutes from first receipt. Persistence prevents ordinary restart replay; restoring an older database or rolling the clock backward can weaken that guarantee. A captured valid request can be raced before its first use; TLS remains necessary.

## Binary frames

`chunk(X)` is `uint32be(byte_length(X)) || X`. Every field must be present, including zero-length token text. Decoders reject truncation, excessive field lengths, invalid UTF-8 text, and trailing bytes.

```text
POST /api/media:
    chunk(UTF8(id))
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
| POST UUID field | 36 |
| Total authenticated request body | 33,624,180 |
| Registration HTTP body | 4,096 |
| Registration code text | 512 |

The shared authenticated extractor applies the full POST body limit to every media method, including GET, DELETE, and PUT. GET/DELETE bodies are hashed but otherwise ignored. The server does not enforce request Content-Type. Limits are per request, with no aggregate concurrency, storage, or account quota.

## Storage and retry semantics

SQLite holds registered keys, hashed registration codes, spent nonces, media rows, encrypted metadata, and tag tokens. Content lives in `blobs/<id>`. Every media operation derives its owner from verified authentication and filters by that owner; another owner's UUID does not authorize access.

Uploads create the content file exclusively, write and synchronize it and its parent directory, then insert the media row and tokens in one transaction. A duplicate UUID returns `409`, even with the same owner and identical payload. There is no upload receipt or idempotent replay. Existing databases drop the obsolete `upload_receipts` table on startup without removing media or tags.

Client upload flows retain the source UUID across retries but prepare fresh ciphertext. If an upload succeeded and its response was lost, retrying returns a conflict rather than confirming success. Refresh the library to check whether the item was saved. Generating a new UUID can create a duplicate; the server does not deduplicate content. API callers who omit an explicit ID receive a newly generated UUID on each upload call.

PUT atomically replaces encrypted metadata and search tokens. DELETE removes the row (cascading tokens and receipt), then unlinks the file. Files and SQLite do not share a transaction: crashes can leave orphan files, including files from interrupted deletion. `gc-blobs` removes unreferenced canonical UUID files after an age guard (default one hour). It uses a database snapshot and an age heuristic, not synchronization with active uploads. It does not repair missing content files.

Wire compatibility is checked by `client/tests/test-vectors.json`, including a POST frame, encrypted content and metadata, tag fingerprints, and a signed request. The metadata vector contains legacy JSON plaintext; current metadata plaintext includes JSON and thumbnail framing, described in [crypto.md](crypto.md).
