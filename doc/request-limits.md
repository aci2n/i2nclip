# Request deadlines, body limits, and transfer admission

Status: body-read deadlines, byte caps, two-upload and two-download admission, and bounded streaming implemented. Cross-process blob coordination is also implemented; see [protocol.md](protocol.md). Storage quotas remain separate work.

## Implemented deadlines

`read_body_with_deadline` wraps the complete streaming read in `tokio::time::timeout`: upload POSTs get 120 seconds, metadata PUTs get 30 seconds, and media GET/DELETE and registration get 10 seconds. Timing starts when body reading begins, after media authentication and existing early length checks. Chunks do not reset it. This does not time HTTP header reception, signature verification, body hashing, database waits, or disk writes.

Timeout returns `408` with `{"error":"request body timed out"}` and `Cache-Control: no-store`. Dropping the read future drops its partial buffer and body. Authenticated requests have already spent their nonce and must retry with a new signature/nonce. Timed-out registration bodies do not consume invitations. Upload admission is checked before the read begins.

Byte caps now follow the table below: GET/DELETE require empty bodies, PUT allows its complete metadata frame, POST retains its existing full frame limit, and registration retains 4,096 bytes. Media limits apply to both early Content-Length checks and streamed bytes; authentication precedes both. The token-text bound is shared between frame validation and cap calculations. Test-only features enable controlled channel bodies and Tokio's paused clock, without adding production features or new crates.

Current verification is recorded in [priorities.md](priorities.md).

## Implemented byte limits and admission

| Request | Implemented maximum body bytes | Implemented total body-read deadline |
| --- | --- | --- |
| Media GET and DELETE | 0 | 10 seconds |
| Metadata PUT | 69,640 (two prefixes + 65,536 metadata + 4,096 token text) | 30 seconds |
| Upload POST | 33,624,140 (three prefixes plus metadata, content, and token text) | 120 seconds |
| Registration POST | 4,096 (existing limit) | 10 seconds |

The implemented deadlines cover the entire body read, not just the interval between chunks. They apply even if a client keeps trickling bytes. A missing or dishonest Content-Length cannot bypass streaming byte counts. A nonempty GET/DELETE body returns `413`; an unfinished empty-body request times out. Oversized requests return `413`, expired body reads return `408`, and body transport failures retain the existing `400` response.

The server allows **two concurrent upload POSTs per router instance (one in the server process)**, shared across owners. It checks signatures and early length limits first, then tries to acquire a permit without waiting, before buffering the body. If both permits are occupied, it returns `503` with JSON `{"error":"uploads busy; try again"}` and `Retry-After: 1`. The client retains the failed file for manual retry. No automatic retry loop or new UI is added.

A valid authenticated header spends its nonce before admission/body processing, as it does today. A retry after `503`, `408`, or `413` must be newly signed with a new nonce. Bad signatures remain `401` and must neither read the body nor use upload capacity. Health, listing, metadata edits, deletion, and registration do not acquire upload permits.

The two-upload limit bounds the number of retained large upload workflows, not exact RSS. Frame decoding still copies content and `Vec` allocation may overreserve; removing those copies is a separate planned change. Download streaming separately bounds active download reads. These limits do not bound the number of small requests, total disk usage, or storage per owner.

## Code changes

Completed: `src/lib.rs` defines the shared token-text bound and both frame caps, and `src/frame.rs` uses that bound for token field validation. The handlers in `src/media.rs` select their own caps and deadlines. `AppState` initializes a shared semaphore with two upload slots. No new configuration surface is needed initially.

The private `MediaRequest` extractor in `src/media.rs` verifies signed headers and retains the unread body. Each endpoint chooses its own policy: upload uses `MAX_BODY` and 120 seconds, retag uses `MAX_META_BODY` and 30 seconds, and list/download/delete require an empty body within 10 seconds. Only list parses search tokens and the pagination cursor.

Handlers reject oversized Content-Length before reading. Upload then acquires its permit before buffering. Shared helpers cap streamed bytes, enforce the body deadline, and verify the signed body hash on the blocking pool. Registration uses the bounded reader with its own cap/deadline. Error responses retain `Cache-Control: no-store`.

`AppState` holds `Arc<tokio::sync::Semaphore>`, initialized with two permits. After successful authentication and early length checks, upload POSTs call `try_acquire_owned` and reject immediately if no slot is available. Requests do not wait in an admission queue.

**Permit ownership is the critical detail.** `BufferedBody` keeps the permit with the buffered body through hashing, frame decoding, and the blocking storage operation. Moving only the byte vector into `spawn_blocking` and dropping the permit when the HTTP task is cancelled would release capacity while the worker still retains the large buffer. Both move together into each blocking closure and return together from the hash stage. The storage stage drops its buffered body and permit after producing the storage result. Dropping a request while reading its body releases its permit normally.

Transfer limits do not alter signatures or plaintext caps. The current hash-identifier format removes the POST identifier field and uses content-hash metadata AAD. The staged-file journal and upload admission coordinate GC as described in [gc.md](gc.md).

## Tests and acceptance criteria

- Completed: signed nonempty GET/DELETE bodies return `413`, with and without Content-Length; ordinary empty requests still work. Declared oversized media bodies are rejected without polling.
- Completed: PUT and POST enforce their distinct caps, including channel bodies crossing the boundary and dishonest length headers. Full valid frames at both exact maximum sizes are accepted, as is a padded valid registration JSON at 4,096 bytes. Registration rejects streamed overflow at its smaller cap.
- Completed: a stalled body returns `408`, and a trickling body cannot extend the total deadline. Controlled channel bodies and Tokio's paused clock test body disposal, all endpoint deadlines, spent authentication nonces, and preserved registration invitations. `test-util` and `http-body-util`'s `channel` feature are enabled only for dev dependencies.
- Completed: two authenticated stalled upload streams hold both slots. A third returns `503` and is not polled. Non-upload requests and invalid signatures still return their normal statuses while slots are occupied.
- Completed: failed reads, timeouts, invalid frames, and successful writes release capacity. Cancelling an HTTP task during body reading releases its permit. A focused controlled-worker test verifies cancellation during a blocking operation does not release capacity before that worker finishes.
- Existing signature-before-body, replay, ownership, duplicate-upload, registration, and shared Rust/JavaScript vector tests still pass.
- Completed: `make test` under Node 22, touched-file formatting checks, and `make extension`; the limits/statuses are documented in `protocol.md`.

## Implemented download streaming

Content GETs acquire one of two download slots after authenticated empty-body verification, without waiting. These slots are separate from upload slots. Saturation returns `503`, `{"error":"downloads busy; try again"}`, `Retry-After: 1`, and `Cache-Control: no-store`. The nonce has been spent. Capacity is checked before ownership lookup, so an authenticated saturated request returns `503` even for a missing/unowned hash; without saturation those requests return `404`.

`store::open_content` queries the owner's stored ciphertext length and opens the file while holding the database mutex used by API deletion. Lengths must be between 29 bytes (minimum sealed blob) and 33,554,496 bytes (content cap), and the opened regular file's length must equal the indexed length. Invalid lengths/mismatches return `500` before response headers; missing files return `404`. The opened handle pins the original file across API deletion. Run one server per data volume; GC uses the same database mutex. Arbitrary external mutation remains outside the trusted-directory model.

`media::content_response` streams the opened file with a 64 KiB chunk bound and Tokio file buffer bound. It sends exactly the indexed number of bytes and declares Content-Length. Later growth cannot expand the response; later truncation causes a transport/body error rather than successful short content. The permit travels with blocking file opening and then with stream state until EOF, an error, or response-body disposal. Tokio may finish an already started bounded file read after cancellation; no detached whole-file read is created. Immutable cache headers are retained because content URLs now contain the sealed-content hash.

Tests cover chunk bounds, shared admission, completion and partial/unpolled response disposal, owner isolation, API deletion and a different hash upload with an active stream, invalid indexed sizes, mismatched/missing files, midstream truncation, and growth after opening. Storage quotas remain a deployment/trust-policy decision.

## Decoder allocation regression test

Frame decoding borrows metadata and content from the buffered request. The blocking worker still owns the request and upload permit; returning an `Item` copies only its metadata. This does not change network buffering or the wire format.

Run the test with measurements visible:

```sh
cargo test memory_profile_frame_decoding -- --nocapture
```

The test uses [allocation-counter](https://github.com/fornwall/allocation-counter) as a dev dependency. It counts Rust heap allocations on the measured thread; input frames are constructed before measurement. It is part of ordinary `cargo test` / `make test` and is not linked into the production server.

Measured with the maximum content and metadata sizes:

| Decoder scenario | Total bytes allocated | Peak additional live bytes |
| --- | --- | --- |
| POST, no tags | 0 | 0 |
| PUT, no tags | 0 | 0 |
| Old metadata/content copy pattern (positive control) | 33,620,032 | 33,620,032 |
| POST, 32 tags, 1 KiB content | 2,816 | 2,144 |
| POST, 32 tags, maximum content | 2,816 | 2,144 |

Assertions require zero allocations without tags, identical allocations for small and large tagged content, and a bounded tag-allocation budget. The positive control proves the counter observes the removed copies. These measurements cover decoder allocations only: they exclude the original request buffer, response metadata, SQLite's C allocations, filesystem caches, and other threads. They are not process RSS or an end-to-end memory profile.
