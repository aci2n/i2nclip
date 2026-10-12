# Implementation plan: item 36 — Ephemeral Add Library setup

## Goal and behavioral decisions

Keep unfinished form state in the current page and key generation/registration workflows in temporary **owner memory**. Persist a library identity/catalog entry only after registration succeeds. Remove resume, Cancel Setup and discard-pending-creation UI. Follow [the implementation guide](implementation-guide.md), retaining item 35's duplicate pairing outcome.

Apply the policy to first-library creation as well as Add Library. Closing setup, leaving Settings, changing the selected library, locking/resetting the vault or disconnecting the page ends an unfinished draft. A new draft receives the current `Personal N` default; no typed invitation, name or server is restored after close/reopen. A failed submission may keep ordinary form fields and its error while the form remains open, but its generated key is dropped; the next submit creates a fresh identity.

**Registration cannot be atomic with local storage.** If the server accepts a key but its reply is lost, or the final local save fails, the invitation may be used and this design discards the transient identity. Show an explicit uncertainty message and request a fresh invitation/restart; do not claim a key is saved or automatically retry/consume another invitation. This is the intended consequence of removing durable pending creation. Do not silently reintroduce persisted retry keys to avoid it.

## Code map

- `stores/setup.js`: adapter currently calls `libraries.beginSetup` before submission, tracks resumable rows, and closes only visually without discarding its draft.
- `stores/settings.js`, `session.js`: per-library drafts, persisted retry/discard controls, and `renameForSetup()` which currently writes before registration.
- `service/engine.js`: `add()`, `activate()` and last-library forget create persisted placeholders; catalog commands persist setup rows; imports discard placeholders.
- `service/identity.js::create()`: saves `pendingRegistration` before registering, then saves the final identity. `service/runtime.js`: dispatch/projections and pairing lifetimes.
- `service/repository.js`: encrypted catalog writes, `putLibrary`, `importLibraries`, scoped configuration, cleanup of associated upload sources.
- `service/client.js`, `scope.js`, `contract.js`: routing, pending replies, default selection and setup snapshots.
- `Settings.svelte`, `Setup.svelte`, `App.svelte`, `stores/application.js`: first/additional setup, navigation and selection.
- `registration.test.js`, `catalog.test.js`, `vault.test.js`, `e2e/setup.spec.js`: existing tests intentionally assert durable retries/resume and must be replaced, not retained with different messages.

## Architecture to implement

Use a per-client temporary setup session in the owner with a generated attempt ID and abort controller. Reuse the existing pairing/identity workflow machinery via an in-memory repository adapter where helpful. Keep these sessions separate from saved `rows`/catalog; no `putLibrary`, rename, provisional `setConfig` on the encrypted repository, or persisted placeholder is allowed before remote success. The owner alone holds generated/private keys.

Expose explicit setup lifecycle commands (suggested names `setup.open`/`setup.close`) and route its identity/pairing actions by a setup ID owned by the initiating client. Add a sanitized setup state to **that client's** projection: ID, busy/error and pairing state; no private keys. Opening the form itself can remain page-local; allocate owner resources lazily when an action needs them. The existing setup session/settings/pairing facades may remain if they adapt this projection.

A completed setup returns `{ outcome, libraryId }`. For new registration, finalize one encrypted record, install the saved runtime, publish it, then let the page select it. Pairing acknowledges after durable destination resolution and returns the same new/existing outcome from 35. Restore continues using the existing atomic vault import rather than a temporary identity-registration path.

## Implementation sequence

1. Add owner temporary-session storage and lifecycle handling with client ownership and vault-epoch validation. Disconnect, lock, reset and explicit close abort and dispose it. Capture a draft generation in the page store so a late result cannot close/promote a newer form. Closing must cancel owner work, not just ignore its UI reply.
2. Route temporary identity/pairing commands without making them a saved library. Keep approval/cancel commands reachable while receive is pending: **do not hold the engine's global serialized queue while awaiting a pairing handshake or user approval**. Serialize short durable catalog commits and existing identity mutations, preserving the host Web Lock.
3. Refactor `identity.create()` to validate server/method, generate a key in memory, perform OTC or authenticated registration, and save only the completed configuration. Remove the durable pending/retry branch, its status text and `discardCreation`. Keep generated key references inside owner memory and clear them on failure/disposal; JavaScript key strings cannot be securely zeroed, so do not promise physical erasure.
4. For authorization, validate the selected saved authorizer again at submission, take its server from the owner, and use its guarded identity operation. Never trust an edited setup URL or client-provided claim that it is unlocked. A lock/forget/reset of the authorizer invalidates authorization and prevents a late final commit.
5. At final commit revalidate name (trimmed 1–80 chars, case-insensitive uniqueness), server, vault epoch and attempt ownership. Name validation happens initially too, but another page may create/rename meanwhile. Write the completed identity/name together in one encrypted repository transaction; install only after commit. On local commit failure leave catalog unchanged and report the remote/local uncertainty above. Do not persist transient key-bearing state.
6. Replace first-library persisted placeholders with an empty-catalog setup view using the same temporary path. When forgetting the last saved library, leave an empty catalog and render setup; do not create a new durable empty row. Adapt `scope.js` so no selected ID is required before setup succeeds. Preserve completed-library record shape and recovery wire format.
7. Remove obsolete `libraries.beginSetup`, `libraries.discardSetup`, setup-only `libraries.add` callers, durable `setup` metadata, `setups` resume projections and `pendingRegistration` UI/contract fields. Search all callers, test adapters and documentation before removing a command. Keep ordinary saved-library rename/forget/reset and unrelated restore cancellation.
8. Clean up **only old unfinished records** on successful unlock/activation: rows with no completed `identity.privateKey` and legacy `setup`/`pendingRegistration` or placeholder markers. Remove their jobs/encrypted source blobs atomically; an empty placeholder is not a real library. A completed `identity.privateKey` wins even if stale setup markers exist: preserve that identity and clear obsolete markers. Perform cleanup before installation/publication; failure leaves the vault closed with a recoverable error. No SQL migration or legacy table cleanup is needed.
9. Update `createSetup.close()`/`dispose()` to clear the draft, cancel pairing and invalidate the attempt. Have application navigation/selection close unfinished setup; do not depend only on Svelte component destruction because stores live at the app root. Completion-driven selection and restore must not cancel their own just-completed result; guard this transition explicitly.
10. Update `doc/client-service.md` to describe temporary setup ownership/commands, removal of durable pending registrations and the new close/disconnect policy. Keep any existing sender pairing persistence policy distinct from temporary receivers. Remove resume buttons, Cancel Setup, pending-creation notice, Retry registration and discard control. Use the Add Library disclosure itself to close. Errors remain beside Create; successful completion installs/selects exactly one library and clears sensitive form fields. Update first-library and additional setup simultaneously.

## Acceptance matrix

| Event | Local durable result / UI |
| --- | --- |
| Open/type/close; leave Settings; change selected library | No new record/key/job; next open is a clean draft |
| Invalid name/server or missing invitation | No network registration or durable write; field/action error |
| OTC or authorized registration rejects | Existing libraries unchanged; no saved transient identity; error beside Create |
| Successful registration | Exactly one completed record; selected only after commit |
| Double submit/two-page name race | One workflow per draft; owner name validation prevents duplicate names |
| Lock/reset/disconnect during pending network/save | Abort/invalidate; no late install, selection or stale error |
| Lost response or final commit fails | No durable pending identity; uncertainty message; no automatic retry |
| Next submit after failure | Fresh generated public key; current method/server used |
| Pair new/duplicate identity | Item 35 handshake, guarded acknowledgment and selection still pass |
| Restore recovery while setup is open | Existing atomic import and completion survive draft disposal |
| Old unfinished + completed rows on unlock | Unfinished rows/sources removed; completed keys/IDs/names/uploads preserved |
| Cleanup commit fails | No partially activated catalog; vault error; later retry possible |

## Verification

Replace durable-retry tests in `registration.test.js`; use deferred registration and failing repository commits to assert ordering and zero provisional writes. Extend encrypted `vault.test.js`, not only the simplified catalog fake, for atomicity and legacy cleanup. Update `catalog.test.js`'s close/reopen/resume expectations and fake repository interfaces. Update the E2E fixture's setup selection fallback and `setup.spec.js`/`multi-library.spec.js` accordingly; keep real API tests for OTC and authorization.

Run focused registration/catalog/vault/pairing suites, client checks, and Firefox/Chromium setup/multi-library browser scenarios. Inspect first-library and Add Library screenshots at 320/360 px in both themes. Rust tests are needed only if an API contract changes; this plan requires none.

## Implementation notes

Record the temporary-session command/state contract, cancellation/commit boundary, compatibility cleanup, registration uncertainty wording, and verification. Review the owner lifecycle and persistence diff before marking this larger item complete.
