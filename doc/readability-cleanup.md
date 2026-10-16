# Readability cleanup specification

## Goal, scope and exclusions

Apply the six reviewed simplifications as six cohesive commits: reuse audio
upload bytes, distinguish tag insertion from replacement, consolidate pure tag
parsing, decode validated Rust envelopes once, clarify private HTTP helpers,
and correct documentation. Include this specification in the first commit.
No UI, schema, wire-format, dependency, compatibility, deployment or persistence
changes are included. Keep both authentication extractors.

## Interfaces and ownership

Upload preparation passes its existing bytes to `thumbnail(blob, bytes, signal)`;
audio artwork consumes those bytes instead of reading the file again. Bitmap and
video resources retain their existing owners and cleanup.

The database owns transactions. New uploads call `insert_tags`; metadata updates
delete old tags before calling it. Empty insertions perform no query. Preserve
quota locks, duplicate-conflict precedence and complete file/tag transactions.

The protocol tag module owns normalization, splitting, list parsing and unique
spellings. Crypto consumes that module for HMAC input; callers import directly
without compatibility re-exports. Strict search validation remains distinct from
comma-splitting input parsing.

Rust `check_blob` returns a validated borrowed `Sealed` envelope. Public
`looks_sealed` keeps its boolean interface and delegates to the same validation.
Tag validation inspects the returned ciphertext without decoding again.

Private HTTP helpers use named options. Rename `send`/`sendBytes` to
`requestDocument`/`requestBytes`; retain exported API signatures and the existing
module. XHR owns upload progress; the streaming reader owns download progress.

## Persistence, lifecycle and failures

No stored data, migration, root-store ownership or navigation behavior changes.
Preserve cancellation, stale-result guards, sequential upload failures, local
size checks, URL/bitmap/player cleanup, atomic tag replacement and rollback.
Preserve first tag spelling, Unicode normalization, all limits, duplicate-entry
validation, malformed/trailing-data errors and crypto vectors. HTTP signing,
caching, fetch fallback, content caps, metadata conflicts and error messages stay
unchanged. Direct SignedRequest extraction requires a registered signer;
RegistrationRequest skips only that lookup and shares body handling.

## Acceptance and commits

1. Reuse upload bytes: prove a single audio file read, preserved content/artwork,
   and cancellation cleanup; retain thumbnail/media tests.
2. Separate tag insertion: retain real PostgreSQL insertion, replacement,
   clearing, conflict, concurrent-write and rollback coverage.
3. Consolidate parsing: retain tag, strict-search, Unicode and shared-vector tests.
4. Decode envelopes once: retain malformed/size/empty-label/duplicate validation
   and borrowed-buffer allocation checks.
5. Clarify HTTP helpers: retain exact signing, XHR/fetch progress, streaming
   cancellation/caps and metadata-conflict/error tests.
6. Correct stale priorities and document extractor guarantees; record verification.

Each code commit must pass focused checks and build without warnings. Use the
repository formatting/import commands. After refactoring, run `make test-all`,
including isolated PostgreSQL and Firefox/Chromium flows. Tests isolate mutable
state and clean up resources on success and failure. No new tests solely for
renames/comments; no visual review is needed unless presentation changes.

## Verification completed

The five code commits passed their focused checks and warning-free builds.
The database refactor passed all 26 database unit tests; envelope changes passed
41 Rust unit tests and all-target/all-feature Clippy. Client checks reported zero
Svelte errors or warnings. The audio regressions verify a single input read,
decrypted uploaded bytes/thumbnail, and bitmap release with no upload on abort.

Final `make test-all` passed 138 client tests, lint, formatting, web/extension
build checks, 67 Rust library tests, five configuration tests and 30 PostgreSQL
API tests. Its browser stage passed 63/64: the Firefox touch test received null
element bounds during the thumbnail-to-video transition. No presentation code or
test was changed for this failure. The case then passed three isolated runs, and
the complete `make test-e2e` rerun passed all 64 Firefox/Chromium cases. Browser
tooling emitted its existing NO_COLOR/FORCE_COLOR environment notices.
