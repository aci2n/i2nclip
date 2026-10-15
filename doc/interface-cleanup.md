# Server and client interface cleanup

## Goal and discipline
Implement the eight approved review items as eight independent commits. Reduce
unused paths and clarify existing ownership without changing encryption formats,
API shapes, quotas, media behavior, or persistence schemas. No new dependencies,
compatibility adapters, generic workflow framework, or infrastructure changes.

## 1. Remove unused paths
Use only base64 string password envelopes. Remove session.ready, the unset
metadataUnavailable UI flag, and unused identity-context members (matches,
operation.unlocked, test-only snapshot lookup). Test helpers read their own store;
production cancellation and operation ownership remain unchanged. Existing
password/recovery, session, pairing, and component checks must pass.

## 2. Release redundant media buffers
Keep decrypted arrays local to receive(), including audio-art extraction. The
existing full-content Blob URL is the cache and supports playback, full-resolution
images and saving. Preserve URL ownership, abort/stale checks, failed-download
retry, and revocation on disposal. Test repeated preview/download reuse, Blob
contents, partial failure, cancellation and disposal.

## 3. Session-owned crypto context
Load and verify identity material once when accepting/unlocking an identity.
The loaded context owns nonextractable signing, AES-GCM and HMAC keys and the
public registration key. API functions consume that context, not serialized
private keys; only portable recovery/pairing transfers use serialized identities.
Keep crypto out of rendering and avoid global caches. Persistence contains only
the original identity document. Lock, reset, forget and dispose drop session key
references and abort workflows. Reuse the loaded context during validation,
registration, restore and pairing import. Update real API callers and fixtures,
without fallback input formats. Verify shared vectors, identities, failed/stale
session transitions, requests and pairing.

## 4. Native static assets; no ZIP packaging
Let Vite serve/copy public/favicon.ico normally. Delete custom favicon hooks and
web/extension ZIP generation. Retain build output at client/dist/web and the
unpacked extension at client/dist/extension for Firefox loading. Replace archive
checks with checks of actual build directories, remove zip/unzip prerequisites,
and update Makefiles/docs. Existing container deployment still consumes web
files. Check clean builds and directory contents; do not change visual assets.

## 5. Shared signed-request handling
Move the media header-authenticated extractor to auth as SignedRequest. It owns
parts/body and methods for declared-size validation, bounded timed reading and
body-hash verification; returns owner plus owned bytes. Media handlers keep
transfer guards and upload buffered-byte drop ordering. Reuse it for ping and
signed pairing creation; endpoint limits/deadlines and response mappings stay
unchanged. Preserve nonce reservation before body reading. Test all auth/body
boundaries, replay, timeout and transfer lifetimes via Rust/PostgreSQL suites.

## 6. Pairing synchronization ownership
A clonable Pairings wrapper owns Arc<Mutex<PairingState>>. Expose domain methods
for create, join admission, join, authorization, submit, poll and cancellation;
return owned snapshots or existing failures. Routes never lock or access rooms.
Never hold a lock across await. Preserve checks both before and after body reads,
TTL, attempt budgets, cancellation, ordering and bounded state. Keep pure state
tests internal; test wrapper cloning and route failure/body-admission behavior.

## 7. Root-owned upload batch store
Extract sequential upload orchestration from library into an uploads store owned
by Application. Library retains search, media items and preview navigation. The
upload store owns batch resources/state, resets on identity change, rejects
overlap and suppresses stale progress/results. It invokes library refresh once
a current batch completes. Views subscribe to uploads; components receive plain
props only. Extension uses the same root-owned uploads store. Settings uses
upload activity for quota refresh. Preserve failure-message-only retention,
selection of failed files again, completion notices, cancellation and navigation
survival. Adapt unit and browser tests for the new interface.

## 8. Smaller pairing crypto adapter
Keep lazy executor loading and one PAKE attempt per adapter. Replace manual
pending-job bookkeeping with one disposal signal and a small promise race. Keep
serialized calls, immediate AbortError on disposal, rejection of later calls,
sanitized cryptographic failures and eventual disposal of an in-flight executor.
Retain protocol/PAKE phases and workflows. Test busy calls, disposal before/during
work, isolated attempts and a real verified exchange.

## Acceptance and delivery
Each change must pass relevant tests and warning-free checks before its commit.
After the series run client tests/checker/build, Rust/PostgreSQL suites, build
artifact checks, Clippy/format checks and Firefox/Chromium integration tests.
Inspect actual Firefox screenshots for any visual regression. Test listeners and
databases remain isolated; stop owned services/containers on completion. Commit
each item independently; leave a clean worktree.

## 9. Final namespace and import consistency pass
Review every Rust and client source/tool/test file. Group Rust imports from the
same root within each lexical scope and visibility, separate standard, external,
and local groups, and preserve aliases, glob semantics, conditional compilation,
and public exports. Import sibling modules consistently in router assembly. Use
already imported types/macros/modules instead of requalifying them; import common
HTTP types/routes rather than mixing direct and fully qualified adjacent calls.
Keep qualification where it disambiguates names (for example sqlx::Error versus
application Error) and keep macro attributes/platform-gated paths explicit.
Client imports follow Biome ordering; keep module namespaces where the complete
module is intentionally injected as a service. Move test-only dynamic imports
of ordinary local helpers to static imports; retain lazy PAKE loading.
This is a mechanical style change, without behavior/interface/schema changes or
new dependencies. Check all targets/features with Clippy, Rust tests, client
checks/builds and existing protocol vectors. Commit independently at the end.
