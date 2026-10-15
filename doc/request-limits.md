# Request deadlines, body limits, and transfer admission

Status: body-read deadlines, byte caps, four-upload and sixteen-download admission, and bounded streaming implemented. Transactional PostgreSQL content storage is implemented; see [protocol.md](protocol.md). Per-key storage quotas are enforced transactionally; see [storage limits](storage-limits.md).

## Implemented deadlines

`read_body_with_deadline` wraps the complete streaming read in `tokio::time::timeout`: upload POSTs get 120 seconds, metadata PUTs get 30 seconds, and media GET/DELETE and registration get 10 seconds. Timing starts when body reading begins, after media authentication and existing early length checks. Chunks do not reset it. This does not time HTTP header reception, signature verification, body hashing, database waits, or disk writes.

Timeout returns `408` with `{"error":"request body timed out"}` and `Cache-Control: no-store`. Dropping the read future drops its partial buffer and body. Authenticated requests have already spent their nonce and must retry with a new signature/nonce. Timed-out registration bodies do not consume invitations. Upload admission is checked before the read begins.

Byte caps now follow the table below: GET/DELETE require empty bodies, PUT allows its complete metadata frame, POST retains its existing full frame limit, and registration retains 4,096 bytes. Media limits apply to both early Content-Length checks and streamed bytes; authentication precedes both. The token-text bound is shared between frame validation and cap calculations. Test-only features enable controlled channel bodies and Tokio's paused clock, without adding production features or new crates.

Current verification is recorded in [priorities.md](priorities.md).

## Implemented byte limits and admission

| Request | Implemented maximum body bytes | Implemented total body-read deadline |
| --- | --- | --- |
| Media GET and DELETE | 0 | 10 seconds |
| Metadata PUT | 69,672 (32-byte prior metadata hash + two prefixes + 65,536 metadata + 4,096 token text) | 30 seconds |
| Upload POST | 33,624,140 (three prefixes plus metadata, content, and token text) | 120 seconds |
| Registration POST | 4,096 (existing limit) | 10 seconds |

The implemented deadlines cover the entire body read, not just the interval between chunks. They apply even if a client keeps trickling bytes. A missing or dishonest Content-Length cannot bypass streaming byte counts. A nonempty GET/DELETE body returns `413`; an unfinished empty-body request times out. Oversized requests return `413`, expired body reads return `408`, and body transport failures retain the existing `400` response.

The server allows **four concurrent upload POSTs per router instance (one in the server process)**, shared across owners. It checks signatures and early length limits first, then waits for a permit before buffering the body. If all permits are occupied, the request remains queued until capacity is released or the request is cancelled. Saturation does not return `503`. The body-read deadline starts after admission; no deadline currently bounds admission waiting.

A valid authenticated header spends its nonce before admission/body processing, as it does today. A retry after `503`, `408`, or `413` must be newly signed with a new nonce. Bad signatures remain `401` and must neither read the body nor use upload capacity. Health, listing, metadata edits, deletion, and registration do not acquire upload permits.

The four-upload limit bounds the number of retained large upload workflows, not exact RSS. Frame decoding borrows content from the body buffer, but `Vec` allocation may overreserve and SQLx may allocate additional buffers. Download streaming separately bounds active download reads. These limits do not bound the number of small requests, total disk usage, or storage per owner.

## Code changes

Completed: `src/lib.rs` defines the shared token-text bound and both frame caps, and `src/frame.rs` uses that bound for token field validation. The handlers in `src/media.rs` select their own caps and deadlines. `AppState` initializes a shared semaphore with four upload slots. No new configuration surface is needed initially.

The private `MediaRequest` extractor in `src/media.rs` verifies signed headers and retains the unread body. Each endpoint chooses its own policy: upload uses `MAX_BODY` and 120 seconds, retag uses `MAX_META_BODY` and 30 seconds, and list/download/delete require an empty body within 10 seconds. Only list parses search tokens and the pagination cursor.

Handlers reject oversized Content-Length before reading. Upload then acquires its permit before buffering. Shared helpers cap streamed bytes, enforce the body deadline, and verify the signed body hash incrementally, yielding every 64 KiB. Registration uses the bounded reader with its own cap/deadline. Error responses retain `Cache-Control: no-store`.

`AppState` holds `Arc<tokio::sync::Semaphore>`, initialized with four permits. After successful authentication and early length checks, upload POSTs call `acquire_owned().await` and wait in the admission queue if all slots are occupied.

**Permit ownership:** buffered upload bytes and admission remain together through incremental hashing and async database writes. Cancellation drops the request buffer and returns its permit; SQLx rolls back interrupted transactions. Hashing yields every 64 KiB.

## Tests and acceptance criteria

- Completed: signed nonempty GET/DELETE bodies return `413`, with and without Content-Length; ordinary empty requests still work. Declared oversized media bodies are rejected without polling.
- Completed: PUT and POST enforce their distinct caps, including channel bodies crossing the boundary and dishonest length headers. Full valid frames at both exact maximum sizes are accepted, as is a padded valid registration JSON at 4,096 bytes. Registration rejects streamed overflow at its smaller cap.
- Completed: a stalled body returns `408`, and a trickling body cannot extend the total deadline. Controlled channel bodies and Tokio's paused clock test body disposal, all endpoint deadlines, spent authentication nonces, and preserved registration invitations. `test-util` and `http-body-util`'s `channel` feature are enabled only for dev dependencies.
- Completed: four authenticated stalled upload streams hold all slots. A fifth waits without polling its body and proceeds when a slot is released. Non-upload requests and invalid signatures still return their normal statuses while slots are occupied.
- Completed: failed reads, timeouts, invalid frames, and successful writes release capacity. Cancelling an HTTP task during body reading releases its permit. Cancellation during async work drops its buffer/permit and rolls back pending transactions.
- Existing signature-before-body, replay, ownership, duplicate-upload, registration, and shared Rust/JavaScript vector tests still pass.
- Completed: `make test` under Node 22, touched-file formatting checks, and `make web`; the limits/statuses are documented in `protocol.md`.

## Implemented download streaming

Content GETs acquire one of sixteen download slots after authenticated empty-body verification, waiting when all are occupied. These slots are separate from upload slots. The nonce has already been spent. Capacity is acquired before ownership lookup, so missing/unowned hashes also wait and then return `404`. Saturation does not return `503`. Admission waits and response draining currently have no duration limit.

The [transfer and shutdown proposal](transfer-shutdown-proposal.md) describes finite admission waits, download resource lifetimes, and a process shutdown deadline. Those changes are proposed, not implemented.

`Database::content` selects authorized complete bytes in one statement. SQL length constraints enforce sealed-content bounds. The connection is released before response construction. The body sends owned byte slices in at most 64 KiB pieces without copying each slice, declares Content-Length, and retains download admission until completion or disposal. Concurrent deletion cannot change fetched bytes.

Tests cover chunk bounds, shared admission, completion and partial/unpolled response disposal, owner isolation, and deletion while a response is held. Queued download checks verify that held responses retain their slots and that dropping unpolled or partial responses admits a waiting request. These checks have bounded waits so an admission regression fails instead of hanging the test suite. Full-buffer downloads are intentional; SQLx encoding/decoding allocation remains part of resource profiling.

## Decoder allocation regression test

Frame decoding borrows metadata and content from the buffered request. The async request owns the buffer and upload permit; returning an `Item` copies only its metadata. This does not change network buffering or the wire format.

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

Assertions require zero allocations without tags, identical allocations for small and large tagged content, and a bounded tag-allocation budget. The positive control proves the counter observes the removed copies. These measurements cover decoder allocations only: they exclude the original request buffer, response metadata, SQLx encoding/decoding allocations, PostgreSQL memory, and other threads. They are not process RSS or an end-to-end memory profile.
