# Protocol v1

The API uses HTTP, JSON responses, two small binary request frames, and an application-defined Ed25519 authentication envelope. There is no custom transport, handshake, session token, or cryptographic primitive. TLS terminates at the deployment's reverse proxy. API paths start at the origin root; deployment under a path prefix is unsupported.

## Encodings and identity

`b64url` means URL-safe base64 without padding. Public keys are raw 32-byte Ed25519 keys (43 encoded characters); signatures are 64 bytes (86 characters). Body digests are 64 lowercase hexadecimal characters. Item identifiers (`id`) are the SHA-256 of the complete sealed content blob, encoded as 64 lowercase hexadecimal characters. The server computes them independently. Hashes are globally unique across owners while rows exist; an existing hash returns `409`. There are no UUIDs or caller-chosen content identifiers.

The client generates its identity locally. The server registers only the public key. Registration requires canonical base64url encoding, a point accepted by dalek's `VerifyingKey::from_bytes`, and a key that is not weak (`is_weak()` is false). Invalid or weak keys return `400` before consuming an invitation. An administrator issues a one-time registration code using `i2nclip otc issue`. The code contains 16 random bytes encoded as b64url and defaults to a 24-hour lifetime. PostgreSQL stores SHA-256 of the trimmed code. Registration consumes an unexpired code and inserts the public key in one transaction. An already registered key still requires a fresh valid code; `ON CONFLICT DO NOTHING` prevents a duplicate key error. Registration does not prove possession of the private key.

## Endpoints

| Method and path | Authentication/body | Success |
| --- | --- | --- |
| `GET /api/health` | None | `200`, `{"ok":true}` |
| `GET /api/ping` | Signed; empty body, registered key, fresh nonce | `204`, empty response; `401` if unauthorized |
| `POST /api/register-key` | No signature; JSON `{"otc":"…","public_key":"…"}` | `204` |
| `GET /api/media` | Signed; client sends no body | `200`, `{"media":[…],"next":null}` or a cursor |
| `POST /api/media` | Signed POST frame | `201`, one media object |
| `GET /api/media/{id}/meta` | Signed; client sends no body | `200`, one encrypted metadata object |
| `GET /api/media/{id}` | Signed; client sends no body | `200`, encrypted content bytes |
| `PUT /api/media/{id}/meta` | Signed metadata frame | `200`, one media object |
| `DELETE /api/media/{id}` | Signed; client sends no body | `204` |

Metadata reads return the same media object as list entries, without content bytes, and use `Cache-Control: no-store`. Missing items and items owned by another identity return `404`. Metadata reads do not consume download slots. Metadata updates are available only at `/api/media/{id}/meta`; the old PUT route returns `405`.

Metadata updates are generic: filenames, tags, and other metadata travel in the
same encrypted frame. The server cannot read or patch plaintext fields. The
client library exposes `updateMetadata(id, patch)` to merge changes such as
`{ name: "New filename.png" }` or `{ tags: ["Vacation"] }` into the current
metadata, preserving omitted fields and the thumbnail. Supplied tags are
normalized and deduplicated. The prior encrypted metadata hash protects updates
against concurrent changes; content bytes and their ID do not change.

A media object contains `id`, `created_at` (server Unix seconds), `bytes` (encrypted content length), `tokens` (search fingerprints), and `meta` (encrypted metadata encoded using **standard padded base64**, not b64url).

List queries accept repeated `tag=TOKEN` parameters and optional `after=CREATED_AT.ID`. All distinct requested tags must match. Pages contain at most 24 items, ordered by creation time descending and hash ascending. `next` is the last returned item's cursor only when another row exists. Pagination is not a snapshot: intervening mutations may change results. Unknown query keys are ignored, empty token values are ignored, and the last repeated `after` wins. The hand-written parser does not percent-decode values; use the literal token/cursor alphabet.

Errors are JSON `{"error":"…"}`. Statuses include `400` for malformed data, `401` for failed authentication or replay, `403` for invalid/expired/spent registration codes, `404` for missing or unowned items, `408` for body-read timeouts, `409` for an existing sealed-content hash, `413` for oversized HTTP bodies, `503` for temporary service unavailability such as a database-pool acquisition timeout, and `500` for internal failures. Some field-size violations become `400` during frame validation. JSON and empty responses use `Cache-Control: no-store`. Content responses use `application/octet-stream` and `private, max-age=31536000, immutable`; a URL identifies immutable ciphertext. Cached copies may remain readable after deletion or authorization changes.

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

Nonces are globally unique in PostgreSQL, rather than scoped by public key. A nonce expires at `signed_timestamp + 300`; cleanup deletes entries strictly older than the current time. Future-dated requests can therefore remain acceptable for almost ten minutes from first receipt. Persistence prevents ordinary restart replay; restoring an older database or rolling the clock backward can weaken that guarantee. A captured valid request can be raced before its first use; TLS remains necessary. Authentication checks the timestamp before database work and again after nonce insertion. The second check prevents a request delayed past nonce expiry from proceeding after maintenance deletes an earlier nonce row. A request rejected at that second check may leave an expired nonce for the next cleanup sweep.

## Binary frames

`chunk(X)` is `uint32be(byte_length(X)) || X`. Every field must be present, including zero-length token text. Decoders reject truncation, excessive field lengths, invalid UTF-8 text, and trailing bytes.

```text
POST /api/media:
    chunk(encrypted_metadata)
    chunk(encrypted_content)
    chunk(UTF8(tokens joined by LF))

PUT /api/media/{id}/meta:
    raw SHA-256 of the previously read encrypted metadata (32 bytes)
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
| Metadata PUT request body | 69,672 |
| Media GET/DELETE request body | 0 |
| Registration HTTP body | 4,096 |
| Registration code text | 512 |

After header authentication, each media handler selects its byte cap: POST allows 33,624,140 bytes, PUT allows 69,672 bytes (the 32-byte hash, two chunk lengths, encrypted metadata, and token text), and GET/DELETE require an empty body. Both the early Content-Length check and the streaming reader use that cap; missing or dishonest length headers cannot bypass the byte count. Nonempty GET/DELETE bodies return `413`. Authentication still happens before body reads and early size rejection, so authenticated oversized requests spend their nonce. Registration retains its separate 4,096-byte streaming cap. The server does not enforce request Content-Type. Upload admission has four slots and download admission has sixteen slots per router. Each registered key defaults to 536,870,912 encrypted-content bytes (512 MiB) and 10,000 files. Administrators can assign invitation limits or update key limits through the CLI. Uploads lock the owning quota row and reserve encrypted-content bytes and a file slot in the insertion transaction; exceeding either limit returns `409` with `Library storage limit reached.`. Exact boundaries are allowed. Database checks enforce usage at or below both limits. Reductions below current usage are rejected; existing files remain readable, editable, and deletable at the limit. Deletion decrements usage in the same transaction as removing the owned file; failed, foreign, or repeated deletions release no capacity. Failed uploads roll back reservations. Metadata and PostgreSQL physical storage overhead are not included in the byte quota.

Complete body reads have total deadlines: 120 seconds for media POST, 30 seconds for PUT, and 10 seconds for media GET/DELETE and registration. The clock starts when body reading begins, after media authentication and early Content-Length checks, and never resets on chunks. Timeout drops the body and partial buffer and returns `408`, `{"error":"request body timed out"}`, with `Cache-Control: no-store`. Authentication nonces are already spent; timed-out registrations do not consume invitation codes. The deadline does not cover headers, authentication, subsequent hashing, or storage operations.

## Storage and retry semantics

PostgreSQL holds registered keys, per-key limits and usage counters in `key_quotas`, hashed registration codes, spent nonces, sealed content, encrypted metadata, and tag tokens. Content is a length-constrained immutable `bytea` value with external TOAST storage. Reported size comes from the stored generated `content_bytes = octet_length(content)` column. Quota checks read one quota row, with no per-request SUM/COUNT. The one-time manual migration backfills existing usage; startup does no media aggregation. Every media operation filters by the authenticated owner; knowing another owner's hash does not authorize a download.

The client encrypts content with `UTF8("i2nclip/v1 content")` as AAD. This purpose label is fixed and contains no owner key; each owner's encryption key is already derived from that owner's secret seed. The server cannot verify the GCM tag and cannot enforce such a client-side binding. The client hashes the complete sealed blob (`0x01 || nonce[12] || ciphertext || tag[16]`) with SHA-256 and encodes the result as 64 lowercase hexadecimal characters. It then encrypts metadata using `UTF8("i2nclip/v1 meta " + hash)` as AAD. The POST frame contains only metadata, content, and token text. The server computes the content hash; it does not accept a client identifier. Content GETs check that the received sealed bytes hash to the requested identifier before decryption.

Uploads insert sealed content, metadata, and tags in one transaction. A file primary-key conflict returns `409`, including across owners and independent application instances. Other constraint failures remain database errors. An interrupted or failed transaction leaves no partial item or tags; no receipt replays success.

DELETE removes the authorized row and cascading tags in one statement. Downloads select owned complete content in one statement, release the database connection, and retain those bytes independently of concurrent deletion. Internal maintenance runs once on startup and hourly, deleting nonces with `expires < now` and invitation codes with `expires_at <= now` in one transaction. Sweeps do not overlap or acquire upload admission; failures retry next interval.

An exact sealed-payload retry gets `409` after success. The application prepares fresh ciphertext when a failed upload is retried, so re-encryption normally creates a new hash and another item. After a lost successful response, refresh the library before retrying to avoid creating another copy. No nonce reuse or cached replay body is introduced.

PUT locks the authorized file row and compares the submitted prior metadata hash with the stored ciphertext hash. A mismatch returns `409` with code `metadata_conflict` and the current encrypted media object, including its tags; it makes no changes. A matching hash replaces metadata and tags in one transaction; sealed content, size, and creation time remain unchanged. Lists fetch metadata and sorted tags in one SQL statement without selecting content, preserving owner filtering, AND tag matching, and cursor ordering. Different sealed content uses a different URL, subject to SHA-256 collision resistance. The initial schema is updated directly without migration versions or import tooling.

Upload POSTs share four slots across owners in one server router. After authentication and early size checks, requests wait for an available slot before reading the body. Slot saturation does not return `503`. Authentication has already spent the nonce; any new request must use a fresh signature and nonce. The upload body deadline starts after admission and does not bound queue time. Slots cover body reading, hashing, frame decoding, and storage, until the async request completes or is cancelled. Other endpoints do not consume upload slots.

Content GETs use sixteen separate download slots per router, acquired after authentication and empty-body verification and before fetching content. Requests wait when all slots are occupied; saturation does not return `503`. Missing/unowned content returns `404` after capacity becomes available. There is currently no admission-wait or response-duration deadline. Responses send the fetched owned bytes in at most 64 KiB slices with Content-Length, retaining the permit through completion or disposal. Fetching releases its database connection before response draining. Full-buffer downloads are intentional. Cache behavior is unchanged.

Nonce cleanup runs as part of the hourly maintenance task described above. Its strict `expires < now` boundary matches the request timestamp check; the post-insertion timestamp check protects delayed requests if cleanup has already removed an expired nonce.
