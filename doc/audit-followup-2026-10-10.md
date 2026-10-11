# Audit follow-up — 2026-10-10

Reviewed commit `974df8b`, starting from a clean worktree. The six findings in the earlier audit have corresponding fixes in the current source. This follow-up found two additional P2 correctness issues. Their reproductions used the actual stores with controlled services; they did not require a running database.

## 1. P2 — Multiple pages can submit the same pending upload

Locations: `client/src/lib/stores/pending-upload.js:106`, `client/src/lib/media/upload-workflow.js:54`.

The submission guard is a `busy` flag belonging to one store instance. Each page caches the pending source during preparation. There is no shared claim or Web Lock for the upload ID, and submission does not recheck whether its persisted source still exists. Modified navigation clicks intentionally allow opening another page with the same source ID, so this can occur through normal navigation or tab duplication.

Reproduction: create two pending-upload stores for the same ID, let both prepare, and call `send()` on each while the first transfer is pending. Both invoke the upload service concurrently. The production encryption uses a fresh nonce for each submission, producing different content hashes; the database's hash conflict check therefore cannot deduplicate these uploads. A second page that cached the source can also submit after the first page has succeeded and removed the persisted entry.

Fix: claim submission across pages by pending ID, and recheck persisted availability inside the claim before sending. A Web Lock alone is insufficient if a waiting page sends its cached source after the first page deletes the entry. Keep failure retryable and release the claim on cancellation or page disposal. Test simultaneous submissions and sequential submission from an already-open second page.

## 2. P2 — Tag edits from different library pages silently overwrite each other

Locations: `client/src/lib/stores/media-item.js:60`, `client/src/lib/stores/media-item.js:146`, `src/db.rs` (`update_meta`).

The media mutation guard belongs to one card's store. Two library pages can mutate the same item independently, each replacing the complete encrypted metadata and tag set derived from its own snapshot. PostgreSQL row locking keeps metadata and tokens internally consistent, but there is no revision check to detect a stale replacement, and media updates are not propagated to other pages.

Reproduction: construct two media-item stores for the same ID and start `retag()` on each with a controlled service. Both updates reach the service before either completes. With real persistence, the last committed replacement wins. For example, two pages displaying `[original]` independently add `first` and `second`; the resulting tag set contains only one addition, although both pages report successful saves. The other page remains stale.

Fix: prevent overlapping mutations by identity/server/item ID and detect stale metadata before replacing it. Use optimistic concurrency with a metadata revision/hash or refresh and reconcile edits under a shared lock. A lock alone does not prevent sequential saves from stale pages from losing earlier changes. Add coverage with two independently opened library stores.

## Verification and scope

- `make test`: client unit suite, 19 Rust unit tests, and 3 configuration tests passed under the pinned Node `22.23.3`; Svelte checker reported no errors or warnings. An earlier run under Node 26 reported 82 individual client tests; Node 22 reports 23 test files.
- `make lint`: Clippy across all targets/features, client lint, and Rust/client formatting checks passed.
- `make extension`: build and XPI packaging passed without build warnings.
- `make test-db`: passed after continuing in an environment with the Podman socket available: 28 unit tests, 3 configuration tests, and 22 API integration tests passed; one maximum-size resource profile was intentionally ignored. The initial environment lacked the socket.
- Firefox E2E: all 75 tests passed against a temporary real PostgreSQL database supplied by the project's testcontainers helper. The initial attempt stopped at fixture creation because `I2N_TEST_DATABASE_URL` was unset. Installed-extension verification remains outside this audit; browser tests use the project's Firefox API shim.
- Controlled store reproductions observed two concurrent sends for one pending ID and two concurrent mutations for one media ID.
- Inspected fresh Firefox screenshots of the preparation-error popup at 320 px in dark mode and image cards at 320 px in light mode and 360 px in dark mode. Landscape, panorama, and portrait previews preserved their aspect ratios; controls and long names fit the narrow layouts.

Reviewed authentication, encryption framing/AAD and content hash checks, database ownership and transactions, request limits/admission, client workflow disposal, storage adapters, extension media fetching, application navigation, and build/package configuration. No additional concrete security defect was established in those reviewed areas. Existing documented risks around unbounded admission/response waiting, shutdown, quotas/rate limits, full-file buffering, and server rollback/search omissions remain; deployment proxy behavior was not inspected. Dependency advisory databases were not scanned during this follow-up. Dependency installation used the npm cache, omitting unavailable optional packages and restoring the cached GNU/Linux build and lint bindings; package manifests and the lockfile were unchanged.

At the user's request, the extension minimum was raised to Firefox `157.0.1`, the build target to `firefox157`, and the README updated. Mozilla's [version feed](https://product-details.mozilla.org/1.0/firefox_versions.json) identifies `157.0.1` as the latest stable release, corroborated by its [release notes](https://www.firefox.com/en-US/firefox/157.0.1/releasenotes/). This excludes older Firefox and current older ESR releases. The initial concern about `Blob.bytes()` was ruled out: Mozilla documents support starting in [Firefox 128](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/128).

At audit completion, both findings remained unfixed; audit changes were the report and the requested Firefox baseline update.

## Subsequent implementation

Finding 1 is now addressed: background and popup submissions share a nonwaiting
Web Lock keyed by pending ID. They reread the persisted source inside the lock
before preparing or sending, hold ownership through successful cleanup, and
notify after releasing it. A competing popup retains its tags for explicit retry;
a cached completed or reset-cleared source disables submission. Cancellation
retains ownership until the underlying work settles. Missing Web Locks fail
without sending. This does not provide exactly-once delivery after a lost server
response or browser crash.

Focused workflow/store regressions and all seven popup Firefox tests passed,
including two pages competing for one source, successful cleanup, and explicit
retry after failure. Client/Rust tests, checker, lint, formatting, and extension
packaging passed. The full real-API Firefox suite passed all 77 tests. Busy and missing-state screenshots at narrow widths were
inspected in both themes.

Finding 2 is deferred: metadata and tokens remain atomically replaced, but stale
edits across library pages can overwrite an earlier edit. No metadata-protocol
change was made.
