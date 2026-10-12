# Audit follow-up

Work through these in order. Details and reproductions are in [the audit report](audit-2026-10-10.md).

1. [x] Fix admission tests and documentation: queued downloads now resume after unpolled/partial responses release their permits, waits are bounded, and admission documentation matches the implementation. Corrected the upload test's stale assertion: a queued authenticated empty upload returns 400 for its invalid frame; replay still returns 401. The full PostgreSQL suite now passes, including both admission regressions (22 API tests passed, one resource profile ignored); the real-API Firefox E2E suite also passes with a temporary PostgreSQL database.
2. [x] Retain failed immediate context-menu uploads under individual IDs and provide retry. Every source is saved before sending; failures open a popup with the error and require explicit retry. Success removes only its own source, reset-cleared work is not recreated, and notification failure cannot trigger retry. Unit tests, checker, lint, and extension packaging pass. The built background-to-popup flow and narrow light/dark screenshots were verified in Firefox with a mock API; the full real-API Firefox E2E suite passes (70 tests), including the new context-menu retry regression.
3. [x] Propagate cancellation to tab-injected media fetches and clean up their streams. Each request registers an isolated-frame abort controller before fetching; cancellation aborts that request, and completion/failure removes its state and releases the reader even if cancellation rejects. Six regression tests cover stalled headers/body, concurrent requests, registration cancellation, and cleanup failures. Client tests, formatting/lint, checker, extension packaging, and all 70 real-API Firefox E2E tests pass.
4. [x] Preserve a pending encrypted identity and recover from lost registration responses or persistence failures. Creation saves encrypted pending state before registration; retries reuse the identity and confirm registration with a signed request. Final local writes clear pending state atomically, session-write failure leaves a recoverable locked library, and discarding pending work requires confirmation. Six unit regressions and client checks pass. Firefox verified all 73 cases across the suite and a focused rerun after correcting the session-recovery test navigation; the subsequent full suite also passes (74 tests); narrow pending-creation screenshots were inspected in both themes.
5. [x] Allow preparation failures to retry within the existing upload popup. Keep the original source separately from prepared bytes; explicit submission prepares again after a fetch failure, preserves tag drafts, and blocks duplicate sends. Four unit regressions cover retry, automatic-send suppression, disposal, and server-change cancellation. The real-API browser regression covers preparation failure followed by transfer failure and successful retry without refetching prepared bytes; narrow light/dark screenshots were inspected.
6. [x] Show the decrypted image when downloading an image whose thumbnail was omitted. Cards fall back to the decrypted content URL, and opening the image reuses those bytes. The real-API Firefox regression covers landscape, portrait, and panorama images, checks their decoded dimensions and request reuse, and verifies narrow layouts in both themes. Both preview browser tests, client tests/checker, formatting/lint, and extension packaging pass; screenshots were inspected.

7. [x] Simplify extension uploads: immediate and popup submissions now share `sendPendingUpload` for credential-bound cancellation, transfer, pending-ID cleanup, and notifications. `sendUpload` uses named options; file batches no longer keep a redundant source cache. Added a reading guide and flow diagram to `client/README.md`, and corrected the retry documentation to describe fresh encryption hashes. Client tests, checker, formatting/lint, Rust tests, extension packaging, and all 74 Firefox E2E tests pass.
8. [x] Keep an Upload navigation tab in context-menu windows so Library/Settings visits can return to the pending upload. The application retains its workflow, prepared preview, failure status, and tag draft across navigation and history; links preserve the source ID and automatic-send mode. Ordinary library pages have no Upload tab. All 75 real-API Firefox tests pass. Unit and Firefox regressions cover return navigation and retry without refetching; narrow light/dark screenshots were inspected. Client tests, checker, formatting/lint, and extension packaging pass.
9. [x] Prevent duplicate pending uploads across pages. Background and popup submissions share a nonwaiting Web Lock per source ID and reread session storage before preparing or sending. Competing pages retain their drafts for explicit retry; completed or reset-cleared sources disable submission. Unit regressions cover ownership, retry, cancellation, cleanup, and unavailable coordination. Both two-page Firefox regressions and the full 77-test real-API suite pass; narrow busy/missing screenshots were inspected in both themes. Client/Rust tests, checker, lint, formatting, and extension packaging pass. Stale metadata edits are also addressed through prior-ciphertext hash comparison; see [the audit follow-up](audit-followup-2026-10-10.md).

10. [x] Detect stale metadata edits across library pages. PUT frames carry the prior encrypted metadata hash; the server compares it under the file row lock before replacing metadata and tags. Conflicts return the current item without writing. The client loads current tags and preserves the draft for explicit retry. Database and two-page Firefox regressions passed in the 2026-10-11 review, along with all 78 Firefox tests.

11. [x] Invalidate unlocked web sessions across tabs on reset. Open tabs delete their own tab-scoped session key after the shared local identity changes; resumed tabs reject stale keys through a per-identity generation check. Legacy unlocked sessions relock once and migrate after password entry. Live-event and missed-event Firefox regressions verify reset and restoration of the same library.

12. [x] Device pairing with a 12-character code and OPAQUE. Backend only relays messages; see [the protocol](pairing.md). Explicit approval, encrypted transfer, and a new device password work across web and extension clients. Client/Rust tests, all 81 Firefox tests, final pairing regressions, installed-extension worker/CSP verification, lint, and package checks pass.

12.5 [x] refactor client lock ownership model (shared worker/background service)

13. [x] Remove custom margins from form labels and use container gaps where suitable. Reviewed the full UI for consistent spacing using Spectrum and GOV.UK design-system guidance. Forms, disclosures, cards, empty states, and About now use explicit spacing. Client tests (177), checker, lint, formatting, web/extension builds, and five focused Firefox runs pass; light/dark screenshots were inspected at narrow widths.

14. [x] Multi-library: named client-side catalogs, independent tab selection and passwords, per-library service runtimes, one shared sequential upload queue, and pairing additions preserve personal libraries. Existing registered keys can authorize new keys on the same server; CLI create/register supports an authorizing recovery file. Scoped forgetting, atomic global reset, failure recovery, fresh IndexedDB schema and unchanged recovery/pairing formats are covered. Client tests (143), Rust tests, PostgreSQL API tests (25), all 22 Firefox scenarios, installed-extension/CSP verification, package checks and narrow light/dark screenshots pass.

15. allow multiple pairing sessions for the same owner: if the pk is shared, multiple users may be pairing at the same time

16. pairing state in DB (stateless servers)

17. [x] Replace scripts/dev.sh with compose.yaml: explicit bridge network, PostgreSQL health-gated startup, persistent project-scoped storage, and loopback port/origin overrides. Make development targets now delegate to Podman Compose. Updated setup/reset documentation and shared build-context exclusions for both Compose providers. Verified full and cached image builds, API/web assets, invitation issuance, database readiness and persistence across teardown/restart, and unhealthy-database startup failure in disposable Compose projects.


18. [x] Locked pages hide pending-upload details and release previews; the service rejects source reads without an unlocked identity. Pending sources remain durable and reappear after unlocking. Late preview replies cannot expose sources after locking. Unit regressions, checker and all four Firefox/Chromium popup scenarios pass.

19. [x] Deletion broadcasts the disabled, grayed-out card without refreshing any view; an explicit search removes it. Shared-view unit regression and all 12 targeted Firefox/Chromium scenarios pass.

20. [x] Upload results populate canonical media directly and append cards to matching searches across clients, preserving card owners, pagination and uploads completed during older search requests. Thumbnails reflect the actual encrypted metadata. No per-file list refresh. Client tests (148), Rust checks and all 44 Firefox/Chromium scenarios pass.

21. [x] Removed the unused pairing worker and its obsolete stable-asset route. No replacement worker is needed: pairing crypto runs directly in the service owner, as requested. Static-serving tests and existing package checks verify the remaining SharedWorker entry.

22. [x] Pairing uses one crypto implementation directly in the service owner, with no nested workers or client crypto helpers. Disposable per-attempt executors clear secrets, reject cancelled calls immediately, and mask third-party errors. Real Chromium pairing, shared-tab and multi-library scenarios, crypto regressions, installed-extension CSP verification and package checks pass. Original reproduction: Worker is not defined in the SharedWorker context
VM21:1 Uncaught ReferenceError: Worker is not defined
    at eval (eval at pairingWorker (web-worker.js:1547:17), <anonymous>:1:1)
    at pairingWorker (web-worker.js:1547:17)
    at run (web-worker.js:1820:21)
    at Object.receive (web-worker.js:1922:11)
    at dispatch (web-worker.js:2734:63)
    at async Object.receive (web-worker.js:2798:21)

23. [x] Added Firefox and Chromium Playwright projects sharing the same test code, API fixtures and browser adapters. Browser launch options live in configuration; popup creation uses a shared script-opened-window adapter, and screenshots are separated by project. Both browsers run all scenarios by default, with single-project selection available. All 44 browser scenarios and lint pass.

24. consider moving the "status" section in the library page, and in general all "status" sections in the settings page too, to a shared toast-notification stack. Considerations: some notifications can be dismissed automatically after X ms, some should be persistent until dismissed by the user, like the "uploaded X files" notification. Consider using native <dialog> elements for this. Notifications should live in the service engine layer and be shared across clients. The service should let clients say where to spawn the notification, default to top right.

25. [x] Kept inline feedback, reserved a stable search-status row, and moved upload progress, failures and completed history into a compact Uploads disclosure. Its summary shows active/failure/completion counts without expanding the grid area on every update. Both-browser scenarios (6) pass; checker/lint and narrow Firefox light/dark screenshots verified. Original request: I like the "inline status" messages we display today, close to the owning components. I do think it's a little intrusive in the library page, with "Loading", "Uploading", "clear uploaded" messages showing in the same section, varying the height of the page. Figure out a simple way to improve the situation. Only minimal changes allowed here, not critical. Maybe upload state could go in a new tab? With a dedicated view, a list of uploaded items, options to clear each individually, or to clear all at once. Make it a first-class UI element instead of the inline view we have today. Consider only showing the tab if there are active uploads if it makes sense  (or graying it out if none, whatever is less confusing)

26. [x] Production browser owners include bounded, redacted message and workflow tracing. Requests have correlated IDs, sanitized routes, timings and HTTP status; failures use safe classifications. Removed the build-time tracing plugin, preserved CLI output, and verified redaction/console failure handling, client/Rust checks, four package checks and all 44 browser scenarios. Original request: Tracing in production builds. Debugging the deployed application is difficult because the worker context runs network calls, absorbs failures, etc. I believe we can get rid of the "dev-only" plugin for the tracer and just include it always. Add tracing liberally, both to understand the flow of the application and to debug errors. Of course avoid logging sensitive data. If console is not on, console logs are free anyways.

27. [x] Separate Rename library and Add library disclosures in Settings, collapsed by default. The compact header picker appears only for multiple libraries. Shared create/rename/pair/switch/forget flows pass in both browsers; checker/lint pass and Firefox narrow light/dark screenshots were inspected. Original request: Move the "rename library" and "library name for new library" controls to a dedicated "rename library"/"add library" fieldsets. Move the library picker inline with the header, and make it smaller. Only show it if there is more than one library. Review the user experience for this flow, the current controls are very intrusive.

28. [x] Implemented OTC / Authorize / Pair / Restore tabs, inline authorizer unlock and server-bound authorization, provisional service-owned setups with durable retry, and selection only after successful setup. Manage Library groups selected-library controls; Reset Browser is always last and warning-colored. Shared browser scenarios, owner regression tests and installed-extension checks verify the flow; narrow Firefox screenshots were inspected. Original request: Reorganize the settings page with multi-libaries in mind from scratch. Right now it's shoehorned and hard to understand. Rethink the full setup, which controls belong together, etc. The current layout is good but the distribution of the controls is unintuitive. "Add library" should only be visible if there is a registered library.

29. [x] Show every queued/active file with its own progress bar; the service removes successful batch history five seconds after the last completion, with immediate manual clearing retained. Failed batches remain retryable. Shared-client regression and both-browser timing scenarios pass; narrow Firefox screenshots inspected. Original request: While uploads are in progress, should all of them with a % bar next to the file name. When all are complete, automatically discard automatically after 5 seconds (leave the user option to clear immediately).

30. [x] Added signed GET /api/ping with registered-key, nonce/replay, empty-body and no-store policies. Browser and CLI registration checks use it instead of listing media. Client/Rust checks, 26 PostgreSQL API tests, all 50 browser scenarios and installed-extension verification pass. Original request: For key auth checks, we are doing /api/media API calls I believe. Let's have a authed ping endpoint in the server that can be used for this purpose.

31. Master password and single vault.

32. Default name for new library "Personal N (either index or random number)"

33. strict rules for JS linter

34. Image compression before upload. Not sure what's the best way to approach this, so it requires some planning. Consider converting all images to webp where possible, and compress while preserving quality reasonably. Maybe this could be a user setting "compress images" with some tunable parameters. Not sure what browser support is like for this operation.

35. "This library is already saved. Select its existing entry." while pairing within the same page. Any reason why that wouldn't work?

36. Remove "resume setup" functionality in Add Library. Keep that state in the client, no need for it to be shared, and no need to have resumable setups. Remove "Cancel Setup" too. Same for the "discard pending creation" flow. If registration fails, just show an error message. Keep this one simple, only commit to the vault identities that succeed registration.

37. Move "Forget this library" to the bottom of the page, above "Reset this browser". Same "warning" text color.

38. Server URL should not be editable in "Manage Library". Only OTC/Pair should receive server URLs

39. The automatic upload cleanup after N seconds should keep showing all individual jobs until the cleanup. Right now it removes the jobs immediately and keeps only the "N uploaded [Clear completed uploads]" text

40. Updating tags should not trigger a reload of the library page.

41. Uploaded files should be inserted into the beginning current library page.

42. Do not show "Authorize" tab if there are no authorizing libraries available.

PRIORITY (highest prio first): 31, 32, 33, 35, 36, 34, 35, 36, 37, 38, 39, 40, 41, 42

DEFERRED: 15, 16, 24
