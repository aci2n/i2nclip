# Request deadlines and proposed body limits/upload admission

Status: total body-read deadlines implemented with user approval. Endpoint-specific byte caps and upload admission remain proposals. This is the first part of priority 3 in [priorities.md](priorities.md). Download streaming and storage quotas remain separate work.

## Implemented deadlines

`read_body_with_deadline` wraps the complete streaming read in `tokio::time::timeout`: upload POSTs get 120 seconds, metadata PUTs get 30 seconds, and media GET/DELETE and registration get 10 seconds. Timing starts when body reading begins, after media authentication and existing early length checks. Chunks do not reset it. This does not time HTTP header reception, signature verification, body hashing, database waits, or disk writes.

Timeout returns `408` with `{"error":"request body timed out"}` and `Cache-Control: no-store`. Dropping the read future drops its partial buffer and body. Authenticated requests have already spent their nonce and must retry with a new signature/nonce. Timed-out registration bodies do not consume invitations. No upload semaphore exists yet.

The existing caps remain: all media methods allow the full upload-body cap, and registration allows 4,096 bytes. GET/DELETE bodies are still accepted within that cap; the zero-body and smaller PUT caps below are pending. Test-only features enable controlled channel bodies and Tokio's paused clock, without adding production features or new crates.

Verification passed: `make test` under Node v22.23.3 (55 client tests, 27 Rust tests, Svelte checker with zero errors/warnings), `make extension` without warnings, touched-file Rust formatting, and `git diff --check`.

## Proposed byte limits and admission

| Request | Proposed maximum body bytes | Implemented total body-read deadline |
| --- | --- | --- |
| Media GET and DELETE | 0 | 10 seconds |
| Metadata PUT | 69,640 (two prefixes + 65,536 metadata + 4,096 token text) | 30 seconds |
| Upload POST | 33,624,180 (existing limit) | 120 seconds |
| Registration POST | 4,096 (existing limit) | 10 seconds |

The implemented deadlines cover the entire body read, not just the interval between chunks. They apply even if a client keeps trickling bytes. A missing or dishonest Content-Length cannot bypass streaming byte counts. Once the proposed byte caps are implemented, a nonempty GET/DELETE body will return `413`; an unfinished empty-body request will still time out. Oversized requests return `413`, expired body reads return `408`, and body transport failures retain the existing `400` response.

Allow **two concurrent upload POSTs per server process**, shared across owners. Check signatures first, then try to acquire a permit without waiting, before buffering the body. If both permits are occupied, return `503` with JSON `{"error":"uploads busy; try again"}` and `Retry-After: 1`. The client retains the failed file for manual retry; add no automatic retry loop or new UI.

A valid authenticated header spends its nonce before admission/body processing, as it does today. A retry after `503`, `408`, or `413` must be newly signed with a new nonce. Bad signatures remain `401` and must neither read the body nor use upload capacity. Health, listing, metadata edits, deletion, and registration do not acquire upload permits.

The two-upload limit bounds the number of retained large upload workflows, not exact RSS. Frame decoding still copies content and `Vec` allocation may overreserve; removing those copies is a separate planned change. This step does not bound download memory, the number of small requests, total disk usage, or storage per owner.

## Code changes

In `src/lib.rs`, name the existing token-text bound and derive both frame caps from it rather than repeating `4096`. `src/frame.rs` should use the same constant for its token field validation. Add a fixed constant for two upload slots; the deadlines already have fixed constants in `src/routes.rs`. No new configuration surface is needed initially.

The authenticated extractor in `src/routes.rs` chooses its cap and timeout from the request method:

```rust
let (max_body, deadline) = match parts.method {
    Method::GET | Method::DELETE => (0, Duration::from_secs(10)),
    Method::PUT => (MAX_META_BODY, Duration::from_secs(30)),
    Method::POST => (MAX_BODY, Duration::from_secs(120)),
    _ => return Err(method_not_allowed()),
};
```

Use the selected limit for both the Content-Length early rejection and the existing `read_body_with_deadline` wrapper. Registration already uses that wrapper with its own cap/deadline. Error responses retain `Cache-Control: no-store`.

Add `Arc<tokio::sync::Semaphore>` to `AppState`, initialized with two permits. After successful authentication and early length checks, upload POSTs call `try_acquire_owned` and reject immediately if no slot is available. There must be no unbounded queue of already authenticated upload bodies.

**Permit ownership is the critical detail.** Keep the permit with the buffered body through hashing, frame decoding, and the blocking storage operation. Moving only the byte vector into `spawn_blocking` and dropping the permit when the HTTP task is cancelled would release capacity while the worker still retains the large buffer. Move both together into each blocking closure and return them together from the hash stage. The storage stage releases the permit only after its result and buffers are no longer retained. Dropping a request while reading its body releases its permit normally.

No dependency, database schema, signed-message layout, encrypted format, plaintext-file cap, or client retry semantics changes are proposed.

## Tests and acceptance criteria

- Signed nonempty GET/DELETE bodies return `413`, with and without Content-Length; ordinary empty requests still work.
- PUT and POST enforce their distinct caps, including chunked bodies crossing the boundary and dishonest length headers. Registration keeps its smaller cap.
- Completed: a stalled body returns `408`, and a trickling body cannot extend the total deadline. Controlled channel bodies and Tokio's paused clock test body disposal, all endpoint deadlines, spent authentication nonces, and preserved registration invitations. `test-util` and `http-body-util`'s `channel` feature are enabled only for dev dependencies.
- Two authenticated stalled upload streams hold both slots. A third returns `503` and is not polled. Non-upload requests and invalid signatures still return their normal statuses while slots are occupied.
- Failed reads, timeouts, invalid frames, and successful writes release capacity. Cancelling an HTTP task during body reading releases its permit. A focused controlled-worker test verifies cancellation during a blocking operation does not release capacity before that worker finishes.
- Existing signature-before-body, replay, ownership, duplicate-upload, registration, and shared Rust/JavaScript vector tests still pass.
- Run `make test` under Node 22, touched-file formatting checks, and `make extension`; document the limits/statuses in `protocol.md`.

## Follow-up within priority 3

Downloads need their own admission/ownership design: cap file reads using stored lengths, then stream responses while holding a permit until the response body is dropped or completes. Confirm cancellation releases file handles and capacity. Propose that separately; it is not covered by the two-upload limit above. Storage quotas remain a deployment/trust-policy decision.
