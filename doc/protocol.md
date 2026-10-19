# Protocol: signed requests and chunk content v2

The API uses HTTP, MessagePack documents, and an application-defined Ed25519 authentication envelope. There is no custom transport, handshake, session token, or cryptographic primitive. TLS terminates at the deployment's reverse proxy. API paths start at the origin root; deployment under a path prefix is unsupported.

## Cross-origin browser access

Clients may be hosted at any origin. The API router owns CORS: responses allow
any origin, and unsigned OPTIONS preflights allow GET, HEAD, POST, PUT and DELETE
with Authorization and Content-Type headers. Browser cookies/credential mode are
not enabled; clients authenticate with the existing signed Authorization header.
Authentication failures also carry CORS headers so external clients can read them.
The configured server origin remains part of the signed envelope.

This policy adds no state, persistence or background work and changes no request
cancellation behavior. It does not change static-file serving, HTML framing,
authentication, quotas or permits. Acceptance checks cover preflights without a
key/database and readable success/error responses from unrelated client origins.

## Encodings and identity

`b64url` means URL-safe base64 without padding. Public keys are raw 32-byte Ed25519 keys (43 encoded characters); signatures are 64 bytes (86 characters). Body digests are 64 lowercase hexadecimal characters. Item identifiers (`id`) are fresh client-generated 32-byte random values, encoded
as 64 lowercase hexadecimal characters. An existing ID returns `409`. Every new
upload attempt creates a fresh ID and independent content key.

The client generates its identity locally. The server registers only the public key. Registration takes its public key from the verified Authorization header. Invalid or weak signer keys and invalid signatures return `401` before consuming an invitation. An administrator issues a one-time registration code using `i2nclip otc issue`. The code contains 16 random bytes encoded as b64url and defaults to a 24-hour lifetime. PostgreSQL stores SHA-256 of the trimmed code. Registration consumes an unexpired code and inserts the public key in one transaction. An already registered key still requires a fresh valid code; `ON CONFLICT DO NOTHING` prevents a duplicate key error. Registration requires proof of possession: the existing Authorization envelope is signed by the key being registered, and the body contains only the invitation code. Signature, timestamp, replay and body-hash checks precede invitation consumption.

This is a fresh-format cutover: deploy client and server together with fresh
application data and recovery files. Existing artifacts are not converted or
automatically deleted. Browser platform messages/manifests and test-vector
containers retain their native formats.

## Endpoints

| Method and path | Authentication/body | Success |
| --- | --- | --- |
| `GET /api/health` | None | `200`, `{"ok":true}` |
| `GET /api/quota` | Signed empty GET | `200`, owner limits and usage |
| `GET /api/ping` | Signed; empty body, registered key, fresh nonce | `204`, empty response; `401` if unauthorized |
| `POST /api/register-key` | Signed by the registering key; `{otc: string}` | `204` |
| `GET /api/media` | Signed; client sends no body | `200`, `{"media":[…],"next":null}` or a cursor |
| `POST /api/media` | Signed creation frame | `201`, pending receipt with ID and chunk counters |
| `PUT /api/media/{id}/chunks/{index}` | Signed raw ciphertext plus GCM tag | `204` |
| `GET /api/media/{id}/chunks/{index}` | Signed empty GET; zero-based index | `200`, up to 4 MiB + 16 bytes of encrypted content |
| `GET /api/media/{id}/meta` | Signed empty GET | `200`, one encrypted media summary without content |
| `PUT /api/media/{id}/meta` | Signed metadata frame | `200`, one media object |
| `DELETE /api/media/{id}` | Signed; client sends no body | `204` |

Metadata reads and updates use `/api/media/{id}/meta`. Reads are owner-scoped and uncached, return the same media object as list entries, and do not fetch content bytes. PUT on `/api/media/{id}` returns `405`.

Metadata updates are generic: filenames, tags, and other metadata travel in the
same encrypted frame. The server cannot read or patch plaintext fields. The
client library exposes `updateMetadata(id, patch)` to merge changes such as
`{ name: "New filename.png" }` or `{ tags: ["Vacation"] }` into the current
metadata, preserving omitted fields and the thumbnail. Supplied tags are
normalized and deduplicated. The prior encrypted metadata hash protects updates
against concurrent changes; content bytes and their ID do not change.

A complete media object contains `id`, `created_at` (server Unix seconds), `bytes` (reserved encrypted content length), `meta` (sealed metadata), `descriptor` (sealed content descriptor), and `expected_chunk_count`. Pending files are absent from lists, tags, metadata and chunk reads. DELETE also accepts owned pending files.

Search tokens are sent only in upload/update frames and search filters, never returned in media objects.

List queries accept repeated `tag=TOKEN` parameters and optional `after=CREATED_AT.ID`. All distinct requested tags must match. Pages contain at most 24 items, ordered by creation time descending and ID ascending. `next` is the last returned item's cursor only when another row exists. Pagination is not a snapshot: intervening mutations may change results. Unknown query keys are ignored, empty token values are ignored, and the last repeated `after` wins. The hand-written parser does not percent-decode values; use the literal token/cursor alphabet.

Errors are MessagePack maps `{"error":"…"}`. Statuses include `400` for malformed data, `401` for failed authentication or replay, `403` for invalid/expired/spent registration codes, `404` for missing or unowned items, `408` for body-read timeouts, `409` for conflicting IDs/chunks, quota limits or metadata edits, `413` for oversized HTTP bodies, `503` for temporary service unavailability such as a database-pool acquisition timeout, and `500` for internal failures. Some field-size violations become `400` during frame validation. Document and empty responses use `Cache-Control: no-store`. Content responses use `application/octet-stream` and `private, max-age=31536000, immutable`; a URL identifies immutable ciphertext. Cached copies may remain readable after deletion or authorization changes.

## Request authentication

Every media request and key registration supplies:

```text
Authorization: Bearer PUBLIC_KEY.TIMESTAMP.NONCE.BODY_HASH.SIGNATURE
```

`TIMESTAMP` is decimal Unix seconds. `NONCE` is 16 random bytes encoded as b64url. `BODY_HASH` is SHA-256 of the exact HTTP body bytes, including the complete MessagePack encoding; absent bodies hash as the empty byte string. The signature is plain Ed25519 over the UTF-8 bytes of:

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

The server checks timestamp distance from its clock is at most 300 seconds, checks the public-key allow-list for ordinary requests (registration skips only this lookup), verifies the signature with dalek's `verify_strict`, then records the nonce **before reading the body**. Strict verification rejects weak keys and low-order signature points, including keys stored before registration validation was strengthened. Rejected signatures neither read the body nor spend the nonce. It reads with a streaming size cap and verifies the body digest before performing the operation. Even an invalid body or malformed query spends the nonce after successful header authentication. Retries must use a new nonce and signature.

Nonces are globally unique in PostgreSQL, rather than scoped by public key. A nonce expires at `signed_timestamp + 300`; cleanup deletes entries strictly older than the current time. Future-dated requests can therefore remain acceptable for almost ten minutes from first receipt. Persistence prevents ordinary restart replay; restoring an older database or rolling the clock backward can weaken that guarantee. A captured valid request can be raced before its first use; TLS remains necessary. Authentication checks the timestamp before database work and again after nonce insertion. The second check prevents a request delayed past nonce expiry from proceeding after maintenance deletes an earlier nonce row. A request rejected at that second check may leave an expired nonce for the next cleanup sweep.

## MessagePack documents

Use `application/msgpack`, named maps, snake_case field names and MessagePack
bin for bytes. Each body contains exactly one document, without length prefixes;
malformed documents and trailing data are rejected. Empty HTTP bodies remain
empty (including 204 responses). Map order is not significant to decoding;
signatures and hashes always cover the exact encoded bytes, without reencoding.
Rust borrows content and metadata directly from the buffered request.

```text
POST /api/media:
    {id: string, plaintext_bytes: integer, descriptor: bin, meta: bin, tags: [{token: bin, label: bin}]}

PUT /api/media/{id}/meta:
    {prev_meta_hash: bin, meta: bin, tags: [{token: bin, label: bin}]}
```

`prev_meta_hash` is the raw 32-byte SHA-256 of the previously read encrypted
metadata. A tag token is 32 raw HMAC bytes on the wire and base64url text in the
database and URL query. The server validates every entry before deduplicating,
accepts at most 64 entries, and retains the first label for a repeated token.
Labels must be version-1 MessagePack encryption envelopes, at most 1024 bytes,
with nonempty plaintext length. Clients encrypt the original tag spelling with
a fresh nonce and unchanged AAD `i2nclip/v1 tag TOKEN` (TOKEN is base64url),
then verify both decryption and the label's HMAC before suggesting it.
Only the client can authenticate ciphertext. Query token rules are unchanged.

Signed `GET /api/tags` returns `{tags: [{token, label}]}`, one nonempty encrypted label per distinct owner-scoped token. Labels are replaced with their file's metadata and cascade on deletion; catalog reads never fetch file metadata or content.

| Limit | Bytes/count |
| --- | --- |
| Plaintext file | No per-file policy; size/count/derived bytes must be safe JavaScript integers |
| Plaintext chunk | 4,194,304 (empty content still has one chunk) |
| Chunk PUT/GET ciphertext | Plaintext chunk length + 16; at most 4,194,320 |
| Sealed descriptor | 1,024 |
| Encrypted metadata | 65,536 |
| Encoded tag array | 98,304 |
| Creation POST body | 196,608 (192 KiB) |
| Metadata PUT body | 163,936 |
| Media GET/DELETE body | 0 |
| Registration body | 4,096 |
| Registration code text | 512 |

Authentication and nonce consumption precede capped streaming body reads. An early
Content-Length check and actual byte counting enforce the cap; missing/dishonest
length headers cannot bypass it. Complete body deadlines are 30 seconds for
creation/metadata, 120 seconds for chunk PUTs, and 10 seconds for empty-body media
reads/deletes and registration. Deadlines start after admission and return `408`.
The server does not enforce Content-Type. Raw chunk uploads conventionally use
`application/octet-stream`; other documents use MessagePack.

## Storage, encryption and lifecycle

`files` stores the immutable descriptor, plaintext size, generated expected chunk
count and reserved encrypted size, current chunk count, last-progress timestamp,
metadata and owner. Separate immutable `chunks` rows use `(file_id, index)` as
their primary key and cascade on deletion. Chunk lengths are validated against
the declared file shape. No complete-file bytea is stored or assembled.

Creation atomically reserves `plaintext_bytes + 16 * max(1, ceil(size/4194304))`
and one file slot, locking the quota row first. The default total quota is 512 MiB
and 10,000 files; there is no per-file quota. Exceeding capacity returns `409`
with `Library storage limit reached.`. A new chunk, counter increment, progress
timestamp and final publication are one transaction under a file-row lock.
Identical chunk retries return `204` without changing counters or activity;
different ciphertext at the same position returns `409`. Editing metadata leaves
the descriptor unchanged. Deletion releases the full reservation atomically.

Each upload attempt creates a random ID and AES-256-GCM content key. The immutable
descriptor wraps that key and exact dimensions using a descriptor key derived
from the identity seed, descriptor purpose, and file ID. Metadata has a separate
per-file key; tag labels and search tokens each have separate library-wide keys.
See [cryptography](crypto.md) for the precise descriptor and chunk format.
Complete authenticated chunks are decrypted before any plaintext is exposed.
Readers validate descriptor dimensions, expected chunk count and encrypted byte
sum, exact response sizes, and actual streamed byte counts. Requests for plaintext
ranges allocate at most 4 MiB, even across a chunk boundary. A failed attempt
starts afresh; the client best-effort deletes failed reservations while the session
is active. Session teardown aborts requests and leaves any remainder to maintenance.

Hourly maintenance removes incomplete files idle for at least 24 hours, releasing
chunks, tags and quota in batches of 100. Duplicate PUTs do not prolong this idle
period. Cleanup rechecks incompleteness and time after locking quota then file,
so progress/completion racing cleanup cannot remove a newly active or completed
file. The same task expires invitations and spent nonces. Startup runs embedded
SQLx migrations; this cutover consolidates the schema into `sql/001_init.sql` and
requires recreating old databases. No automatic conversion or deletion is done.

Creation/chunk PUTs share four global upload slots and one per key. Chunk GETs use
sixteen global download slots and two per key. Per-key permits are acquired first;
requests wait at most 30 seconds across both admission stages. Timeout returns
`503` with `Retry-After: 1`, without reading an upload body or looking up content;
the authenticated nonce remains spent. Each download holds at most one 4 MiB + tag chunk,
sends at most 64 KiB per response slice, and releases its database connection before
draining. The stream owns its buffer and permit until completion or disposal;
response slices share that allocation. There is no application response-lifetime
limit, so stalled or unpolled responses retain their resources until disposed.
Chunk URLs have strong ETag
`"{id}.{index}"`, `application/octet-stream`, and
`Cache-Control: private, max-age=31536000, immutable`. Cached ciphertext can remain
after server deletion. The virtual plaintext service-worker URLs use `no-store`.

The standalone server allows 30 seconds from the first shutdown signal for HTTP
draining, maintenance and database-pool cleanup, then exits nonzero on timeout.
Serving exit also starts this cleanup allowance. Configure the container/service
stop allowance above that deadline (Compose uses 40 seconds). An in-flight upload
can be interrupted; uncommitted transactions roll back, while a lost reply after
commit remains an uncertain outcome.

## Quota reads

`GET /api/quota` requires the same signed empty-body policy as media reads. Its
uncached MessagePack map contains `max_content_bytes`, `max_files`, `used_content_bytes`,
and `file_count` for the authenticated public key only. It reads the quota row
without aggregating media, and spends the request nonce even when rejected.

## Web response policy

The `/`, `/index.html`, and `/favicon.ico` routes send
`Content-Security-Policy: frame-ancestors 'none'`, including HEAD, conditional,
and error responses. HTML entry files use `Cache-Control: no-cache`; successful
hashed assets use `public, max-age=31536000, immutable`. Static routes do not
provide an HTML fallback for unknown paths. API caching follows the endpoint
policies above.
