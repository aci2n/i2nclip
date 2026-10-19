# Chunk uploads and browser streaming

Status: implementation specification. Approved decisions are recorded below;
implementation progress and evidence follow at the end. Deploy as a fresh storage
format, with client and server updated together.

## Goal and scope

Support files larger than 1 GiB without allocating complete content buffers for
upload, download, or native audio/video playback. Use independently authenticated
4 MiB plaintext chunks, separate PostgreSQL chunk rows, pending upload counters,
quota reservations, and cleanup of abandoned uploads. Library previews and direct
media links use the same streaming implementation.

Remove every per-file size limit, including invitation/key columns, CLI options,
API fields, client checks, settings, and the existing 512 MiB protocol ceiling.
Retain library byte/file quotas and bounded per-request sizes. Integer values and
all derived counts/byte sums must be nonnegative safe JavaScript integers and fit
PostgreSQL BIGINT; reject overflow before arithmetic or allocation. The existing
512 MiB default library quota is retained as an administrative policy: libraries
must receive sufficient capacity for gigabyte files.

Explicit exclusions: backward compatibility, storage conversion, persisted upload
workflows, resume across reloads, background transfers after the owning tab closes
or locks, parallel upload batches, automatic retries, media transcoding changes,
adaptive streaming, application-managed plaintext caches, extension capture transport redesign, and new dependencies.
The existing extension public-media fetch remains bounded at 32 MiB because its
handoff buffers a complete File; large local files use the chunked web upload.

The user's explicit consolidation instruction overrides the ordinary rule to
preserve applied migrations: replace sql/001_init.sql with the final schema and
remove sql/002_max_file_plaintext_bytes.sql. Retain SQLx startup migration
execution; old databases must be recreated because their history/checksums no
longer match. Do not add a compatibility migration or automatic data deletion.

## Content format and interfaces

Each upload attempt generates a new 32-byte random ID (64 lowercase hex digits)
and random 256-bit AES-GCM content key. IDs no longer hash ciphertext. Never reuse
a file ID/key for another attempt. Wrap the raw content key in an immutable sealed
content descriptor, separate from editable metadata. Descriptor plaintext is
MessagePack {v: 2, key: bin[32], plaintext_bytes: integer, chunk_bytes: 4194304,
chunk_count: integer}; use the library encryption key, random 96-bit IV, the
existing sealed-envelope encoding, and UTF8("i2nclip/v2 descriptor " + id) as AAD.
Import the unwrapped content key as nonextractable and release temporary raw key
buffers after import. Metadata remains sealed separately using a file-ID-bound
purpose; edits retain the descriptor unchanged.

Chunk count is max(1, ceil(plaintext_bytes / 4194304)). Empty content has one
zero-length plaintext chunk. Every nonfinal chunk has 4194304 plaintext bytes;
the final length follows from the declared file size. A chunk is raw AES-256-GCM
ciphertext followed by its full 16-byte tag, with no envelope. Its 12-byte IV is
four zero bytes followed by the unsigned chunk index as eight big-endian bytes.
AAD is UTF8("i2nclip/v2 chunk\n" + id + "\n" + index + "\n" +
chunk_count + "\n" + plaintext_bytes + "\n"), using canonical decimal integers.
Authenticate the complete chunk before exposing any plaintext. The descriptor,
position, count and exact lengths replace the whole-file content hash check.

Rust reference crypto and client crypto share deterministic vectors for the new
format, including empty content and substitution/tampering failures. Request
signatures, identity, pairing, recovery, and searchable tags retain their formats.

- POST /api/media accepts {id, plaintext_bytes, descriptor, meta, tags}; creation
  validates sizes and reserves capacity. Its pending receipt contains id,
  expected_chunk_count and current_chunk_count. Cap the complete body at 192 KiB,
  descriptor at 1024 bytes, and retain metadata/tag field limits.
- PUT /api/media/{id}/chunks/{index} accepts raw encrypted bytes, capped at
  4194320 bytes, with the exact expected chunk length required. Return 204.
  Identical duplicate bytes succeed without changing counts or timestamps;
  different bytes at the same index return 409. Completion is automatic on the
  final missing chunk. Client reads metadata after all PUTs to obtain the final
  media summary.
- GET on the chunk URL reads one complete owned chunk row. Preserve bounded
  response draining, permits, stable immutable ciphertext URLs and private HTTP
  caching. Pending files have no downloadable content.
- Lists, tag catalogs, metadata GET/PUT expose complete files only. Media summaries
  add descriptor and expected_chunk_count; bytes is the full encrypted size.
- DELETE /api/media/{id} deletes owned pending or complete files and releases
  their reservation. Missing/foreign items return 404.
- GET /api/quota drops max_file_plaintext_bytes. Remaining usage includes pending
  reservations; Settings explains that usage includes pending uploads.

Creation uses the metadata body deadline (30 seconds); each chunk PUT uses the
upload deadline (120 seconds). Header authentication, fresh nonces, streaming
body caps, and existing transfer admission precede storage. Per-key/global upload
permits bound chunk processing rather than whole-file lifetime.

## Persistence, concurrency and cancellation

Files own descriptor, plaintext size, full reserved encrypted byte count,
expected/current counts, metadata, creation time and last-progress timestamp.
Chunks have primary key (file_id, index), immutable bounded ciphertext and an
ON DELETE CASCADE foreign key. Tags continue to cascade from files. File format
fields are immutable. A file is complete exactly when current equals expected;
all completion-sensitive queries apply that predicate.

Reserve plaintext_bytes + 16 * chunk_count and one file slot atomically at
creation, under the owner's quota row lock. Reservation failures store nothing.
Insertion of a genuinely new chunk, count increment, progress timestamp and
publication of a complete file are one transaction. Serialize concurrent chunk
insertion using the file row. Operations touching quotas and files lock quota
before file; never retain a transaction/connection while sending responses.
Counters must remain correct across conflicts, failed commits, deletion and
multiple server instances.

Extend startup/hourly maintenance with pending files idle at least 24 hours.
Select candidates in bounded batches and recheck eligibility under quota/file
locks before deleting and releasing reservations. Successful new chunks refresh
activity; duplicates do not. Log reclaimed files/bytes. Failed sweeps retry at the
next interval. Complete files never expire.

Upload stores retain sequential batches, local progress and failures only.
Failure stops the current file, attempts DELETE while the session remains valid,
and continues the batch. Lock, identity/server change or tab closure cancels work;
maintenance handles abandoned reservations. No old-session requests or stale
callbacks may reenter new state. An ambiguous successful response is not silently
retried as a new file.

## Browser delivery and ownership

The unlocked application session owns a shared streaming store, outside the
workspace because a directly opened media link does not create a workspace.
Pass that dependency explicitly to library and direct-link media stores. Stores
own protocol requests, keys, cancellation, ports and transfer sessions; components
receive only presentation state and callbacks.

A same-origin service worker synthesizes plaintext responses for a dedicated
virtual URL namespace. It brokers pull-based MessageChannel requests to the
owning page; keys and authentication stay in the page. URLs contain an owning
client identifier and unguessable token, valid only for a live page session.
Worker restarts must not require rebuilding a persistent worker-global registry.
No server endpoint serves plaintext or accepts these tokens as API credentials.

Support GET and HEAD, 200 responses, single closed/open/suffix byte ranges, 206
Content-Range/Content-Length/Accept-Ranges, and 416 for unsatisfiable ranges.
Ignore unsupported multipart ranges and stream a complete 200 response. Cap each inline partial response at 4 MiB, even when an open-ended Range asks
for the rest of the file; clients can request further ranges. Drain transferred
chunks in 64 KiB slices. Firefox synthesized-response read-ahead must not be
assumed to stop at a slow JavaScript consumer. Use ordinary attachment navigation
without an anchor download attribute and attachment Content-Disposition for downloads; inline responses for native media.
Synthesize Cache-Control: no-store and never write plaintext to CacheStorage.

Give each bridge handshake/read a 30-second response deadline so a closed or
unresponsive owning tab cannot retain a port indefinitely. Enforce backpressure
across the message bridge, at most two chunk reads per
session-owned streaming store, and no growing plaintext cache. Authenticate and
trim only the chunks intersecting each requested range. Consumer cancellation
aborts the associated request and closes its ports. Preview closure releases
playback sessions; downloads remain root-owned across internal navigation.
Session disposal cancels all reads and invalidates tokens. Tab closure/reload,
lock or worker interruption can terminate a transfer; report an actionable error
and allow a fresh attempt. Browser codec/container support remains unchanged.

Build the worker at a stable root URL with no-cache and register root scope to control the initiating page while intercepting only
the virtual URL namespace. Wait for activation before offering stream URLs; a directly opened
media link must work on its first visit. HTTPS or secure localhost is required.
Show an actionable error if service workers are unavailable; do not fall back to
whole-file buffering. Keep the visible file-ID deeplink shape unchanged.

Replace API whole-file Uint8Array interfaces with Blob/File upload sources and
bounded chunk/range readers. Sniff types using a bounded prefix. For files above
32 MiB skip optional conversion/thumbnail/artwork preparation with a notice;
this is a preparation threshold, not an upload limit. Text previews read only
enough chunks for the existing 256 KiB display limit. Native image/media decoding
can still consume memory independently of application transfer buffers.

## Acceptance and verification

First validate the service-worker delivery path in real Firefox and Chromium
against the Rust static listener, with isolated contexts/databases and no runtime
network interception. Cover streamed attachments, range seeking, first visit,
backpressure, cancellation, tab/session loss and worker restart. This is a
feasibility milestone, not evidence that encrypted chunk storage is complete.

Then verify:

- Shared crypto vectors: empty/full/final chunks; wrong file/index/count/size/key;
  mutation, truncation and reordered/substituted chunks fail before delivery.
- Database/API: quota boundaries and overflow, wrong indices/lengths, duplicates,
  concurrent insertion, complete-file visibility, ownership, authentication,
  deletion/maintenance races, expiry boundaries and reservation invariants.
- Client: sequential slicing, bounded buffers, progress, preprocessing notices,
  batch continuation, cancellation and no stale URLs/save actions after disposal.
- Browsers: gigabyte-scale upload/download with complete byte checks;
  audio/video start before complete download, forward/backward seeking including
  tail-indexed MP4, direct links and navigation during downloads.
- Build/hosting: worker emitted and served with correct type/scope/cache policy;
  fresh SQLx initialization and reopening preserve new-format data.
- Resource profile: slow readers, concurrent ranges and uploads; distinguish
  measured application buffering from native decoder/browser download memory.
- Run make test-all and the updated resource profile. Inspect Firefox screenshots
  for UI changes in both themes and narrow widths. Use the documented Node/Rust
  toolchains, isolated databases, loopback port 0 and cleanup on every outcome.

## Progress

- Worktree created on codex/chunk-uploads from committed master. Uncommitted
  changes in the original checkout are intentionally not copied.
- Specification recorded before implementation. Browser delivery feasibility is
  the first implementation milestone; chunk schema/protocol cutover follows it.

### Browser feasibility evidence

The initial transport is implemented as a standalone classic worker plus a
session-owned content-stream store. It is now wired to the chunk API and both library and deeplink media views.
The proof builds a dedicated page and the actual worker and serves them through
the real Rust listener, with a separate database and browser context per test.

Verified in the repository Firefox and Chromium builds:

- First visit and a second independent tab, byte offsets beyond 4 GiB, suffix/
  open/unsatisfiable ranges, HEAD, empty files, and wrong-owner token pairing.
- Native attachment download of 1 GiB + 123 bytes, checking every byte from the
  downloaded file without loading it all into the test process. Source reads
  are at most 4 MiB and sequential.
- Native video playback/seeking and seeking in a generated gigabyte WAV while
  reading less than one eighth of its content.
- Bounded open-ended inline responses, two simultaneous source reads, and source
  disposal during pending requests.

Experiments found that an unread full synthesized fetch response continued
requesting data in Firefox (68 chunks after roughly 3.3 seconds). Chunked message
passing alone therefore does not establish a browser memory bound. Inline range
responses are explicitly capped at 4 MiB, and arbitrary full fetches are not a
supported application consumption path. Native downloads consume into the browser
download sink; decoder/download-manager memory still requires resource profiling.
Chromium cancelled attachment downloads using an anchor download attribute before
reading source bytes; ordinary attachment navigation passed the same byte check.
A standalone classic bundle fixed Firefox worker script evaluation; explicit
client claiming handles pages opened after activation.

Reproduce with the documented Node on PATH, a working Docker/Podman testcontainers
socket (or I2N_TEST_DATABASE_URL), and installed Playwright Firefox/Chromium:

```sh
make test-build
npm --prefix client exec -- playwright install firefox chromium
cargo build --bin i2nclip --example test-server --example test-database
cargo run --features test-containers --example postgres-tests -- \
  npm --prefix client exec -- playwright test --config client/playwright.config.ts streaming.spec.ts
```

### Integrated implementation

- Chunk crypto and Rust/JavaScript vectors are implemented. The immutable sealed
  descriptor contains the per-file key and authenticated dimensions; each raw
  chunk independently authenticates its file, index, size and count.
- `sql/001_init.sql` contains the complete schema; migration 002 is removed.
  File/chunk creation, publication, retries, quotas, deletion and idle cleanup are
  implemented and verified by PostgreSQL and signed API integration tests.
- The web app uploads Blob/File slices and removes per-file limits throughout
  quota/CLI/client interfaces. Optional preparation is skipped above 32 MiB.
- A session-owned stream store supplies library/deeplink native previews and
  downloads, with bounded text prefixes, preview cancellation, deletion
  invalidation, view-independent downloads and context teardown.
- Native loading feedback stays beside the preview; chunk failures offer retry.

Verification evidence is updated after final regression/resource runs. The
cutover requires a fresh database and matching client/server; SQLx still owns
startup migration application. The ordinary future-migration policy resumes
with the next numbered SQL file.
