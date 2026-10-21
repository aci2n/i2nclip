> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Cacheable encrypted content chunks

Historical specification, superseded by [chunk uploads](chunk-uploads.md).

## Goal and scope

Replace full-file server buffering with stable chunk URLs returning ordinary,
privately cacheable HTTP 200 responses. The web client downloads sequential chunks
of at most 4,194,304 encrypted bytes into one in-memory buffer, verifies the full
ciphertext hash, and decrypts it. This supersedes the HTTP Range design: Firefox
bypasses its HTTP cache for bounded Range requests. No schema, encryption, quota,
identity, component, or new persistence changes are needed.

## Interfaces, ownership and lifecycle

GET /api/media/{id}/chunks/{index} returns the indexed 4 MiB portion (zero-based),
with a shorter final chunk. Each URL represents immutable opaque encrypted bytes:
Content-Type: application/octet-stream, exact Content-Length, Cache-Control:
private, max-age=31536000, immutable, and strong ETag "{id}.{index}". Return 404
for a foreign/missing file or nonexistent chunk, and 400 for a malformed index.
GET /api/media/{id} is removed; DELETE remains at that URL. Authentication and
empty-body verification remain mandatory. Each network request requires a fresh
signature and nonce, covering the whole chunk path. Browser cache hits may avoid
the network, as with the previous immutable full-file response. Expose ETag via
CORS; standard browser caching remains enabled, with no custom client cache.

The database computes a checked offset and selects only an owner-filtered bytea
substring, using the generated content_bytes to reject nonexistent chunks.
No size preflight, transaction, snapshot, connection pool, or background producer
is added. Connections are released before sending a response. Each response owns
at most 4 MiB and an existing download permit, released on completion or disposal.
Admission remains per request (sixteen global and two per key).

Keep getContent and media-store ownership unchanged. Validate the known encrypted
size against the protocol ceiling before allocating one destination buffer.
Request consecutive chunk URLs, one at a time, using normal browser caching.
Require 200, validate Content-Length when supplied, count actual streamed bytes,
and reject short/oversized bodies. Copy directly into the destination and report
aggregate progress. Verify the complete ciphertext hash before decrypting; expose
no partial bytes, object URLs, previews or save dialogs.

## Failure and cancellation

Concurrent deletion can cause a subsequent uncached chunk request to return 404.
An already buffered/cached chunk remains readable, preserving existing immutable
cache semantics. Metadata edits cannot change ciphertext. Abort cancels the
active request and stops subsequent requests; partial buffers remain transient.
Retain media-store stale-result checks and HTTP error messages. Unexpected status,
invalid lengths, truncated bodies, or hash mismatch fail without automatic retry.
Quota reductions do not prevent downloads of existing content.

## Acceptance checks and exclusions

Cover full/partial final chunks, exact boundaries, huge/malformed indices, owner
isolation, signed-path binding, nonce replay, CORS, cache headers, and deletion
between requests. Verify paused chunk responses retain no connection/transaction
and release permits on completion/disposal. Test assembly, progress, cancellation,
fresh signatures, wrong status/lengths, absent/dishonest Content-Length, corruption,
and transient failures. Verify browser cache reuse offline in Firefox/Chromium,
and >32 MiB Library/direct-link downloads. Update and run the resource profile
with concurrent slow chunk readers and complete length/hash/byte checks. Run
client/unit/type, Rust/database, lint/format, build, and relevant browser checks.

No HTTP Range/multipart/conditional response handling, automatic retries,
resumability, parallel fetching, upload streaming, temporary files, new timeout
policy, or application-managed cache. Browser memory remains proportional to file
size. Unrelated upload work in the original checkout is excluded.
