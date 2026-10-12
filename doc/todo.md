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


18. dont show pending uploads when locked

19. dont refresh on deletion: keep the card grayed out (prio: 2)

20. dont refresh on upload: on batch uploads refreshing after every upload is jarring

21. rename assets/worker.js assets/pairing-worker.js

22. figure out why pairing Worker does not work in brave: Worker is not defined in the SharedWorker context
VM21:1 Uncaught ReferenceError: Worker is not defined
    at eval (eval at pairingWorker (web-worker.js:1547:17), <anonymous>:1:1)
    at pairingWorker (web-worker.js:1547:17)
    at run (web-worker.js:1820:21)
    at Object.receive (web-worker.js:1922:11)
    at dispatch (web-worker.js:2734:63)
    at async Object.receive (web-worker.js:2798:21)
 
23. consider adding chrome as a target for e2e tests next to firefox. Reuse test code as much as possible. If needed create browser-specific interfaces to abstract implementation details, and use the interfaces in shared tests. Do not check browser type in specific tests.

24. consider moving the "status" section in the library page, and in general all "status" sections in the settings page too, to a shared toast-notification stack. Considerations: some notifications can be dismissed automatically after X ms, some should be persistent until dismissed by the user, like the "uploaded X files" notification. Consider using native <dialog> elements for this. Notifications should live in the service engine layer and be shared across clients. The service should let clients say where to spawn the notification, default to top right.


PRIORITY (highest prio first): 14, 22, 23, 18+19+20+21, 24

DEFERRED: 15, 16
