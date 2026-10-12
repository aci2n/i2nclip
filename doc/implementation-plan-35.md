# Implementation plan: item 35 — Select an existing library after duplicate pairing

## Goal and decisions

Receiving an identity already saved for the same public key and server origin selects that saved library and completes the pairing handshake. There is no second record or error telling the user to select an entry that the current setup cannot select. Follow [the implementation guide](implementation-guide.md).

Complete this before 36; that item must retain the duplicate outcome while replacing durable setup entries with temporary owner state. Treat the duplicate as a successful destination resolution, not a relaxation of generic repository uniqueness validation.

## Code map and failure mechanism

- `service/repository.js::validateIdentity()` rejects an already saved key/origin during `setConfig()`.
- `service/pairing.js::receive()` validates the transferred identity, calls `identity.importPairing()`, then sends step-5 acknowledgment inside `session.withIdentity()`.
- `service/identity.js::importPairing()` currently returns an operation belonging to the receiving runtime's identity context. A duplicate belongs to another runtime; its operation cannot be passed to the receiver's `withIdentity()`.
- `service/engine.js`: catalog/runtimes and durable records are owner-only. `stores/setup.js` promotes only when its own provisional session becomes configured, so a duplicate never promotes.
- `stores/application.js`: `selectLibrary()` owns local selection, URL and library-store lifecycle. `stores/pairing.js` currently catches failures and receives boolean results.

## Implementation sequence

1. Reproduce with two pages in one vault: saved A supplies a code, Add Library receives A. Keep Add Library's name different from A so name validation does not mask the duplicate. Also cover A already being the receiver page's selected entry and A selected in another page.
2. Factor the repository duplicate predicate into one owner-side helper: same registration public key and `new URL(serverUrl).origin`. Ignore name differences and exclude the receiving provisional ID. Validate the transferred private key against its public key **before** resolving a duplicate. A key on a different origin remains a distinct library.
3. Add an owner callback from engine/runtime to the pairing import flow that resolves the saved destination. Preserve final write-time uniqueness checks for races: if a simultaneous import saved the identity after the initial lookup, resolve that same destination instead of writing a duplicate. Do not detect duplicates by parsing an English error string. Use a typed internal result/error with the saved ID; transport replies need only the ID/outcome.
4. Give the import flow a common internal save result: outcome (`saved` or `existing`), destination ID, and an owner-only guarded acknowledgment scope. For a new identity this uses its existing operation/`withIdentity`; for a duplicate it uses the destination runtime's operation/`withIdentity`. Keep the guard implementation owner-side and never put private keys or operation objects on the wire.
5. Run step-5 acknowledgment only after the destination exists durably and its vault/runtime context is still valid. Keep pairing attached to the temporary receiver until acknowledgment settles; selecting/removing it earlier can abort its own handshake. Update `current.saved` only once the destination is safe, keep the existing lost-ack behavior, and dispose both receiver/destination operation handles on all exits.
6. Return/broadcast a structured, key-free completion such as `{ outcome: "existing", libraryId }` after handshake completion. Propagate it through runtime dispatch and the pairing store instead of discarding it as `true`. Let the setup/application workflow select the saved ID in the receiving page, close the setup and show “Existing library selected.” The sender and other pages keep their own selection.
7. Remove only the obsolete unfinished receiver entry after its reply/result can settle. The service client currently rejects pending requests when their runtime disappears from a snapshot; order cleanup accordingly, or explicitly carry completion through a surviving setup command. Never forget/reset the existing destination. Cancellation/failed verification before destination resolution still removes the relay room; successful acknowledgment follows existing relay lifecycle.

## Acceptance cases and verification

- Duplicate receive: sender sees successful acknowledgment; receiver selects saved A, catalog count/ID/key/generation remain unchanged, temporary row is removed, no error remains.
- New receive: one new durable record, correct name/server, normal selection and sender success.
- Same key/different origin is not a duplicate. Equivalent URLs with the same origin resolve to the existing entry; transferred relay server validation remains strict.
- Wrong transferred key/public-key pairing, mismatched verification code and canceled/expired room cannot select or save anything.
- Destination forgotten or vault locked during save/ack: no stale selection/false sender success; cleanup and retry message remain correct.
- Lost acknowledgment after destination resolution preserves the destination and reports confirmation uncertainty, without registering or saving a second identity.
- Two duplicate receivers racing leave exactly one saved identity, and a failed cleanup does not remove the existing library.

Extend `pairing.test.js` for handshake/operation lifetime, `catalog.test.js` and `vault.test.js` for owner duplicate resolution and durable uniqueness, and `e2e/multi-library.spec.js`/`pairing.spec.js` for the same-vault regression. Use real API pairing and two pages; preserve protocol-vector tests. Run client checks and focused Firefox/Chromium scenarios from the guide.

## Implementation notes

Implemented duplicate resolution by registration public key and server origin. Repository uniqueness failures use `ExistingLibraryError` with the destination ID; final-write races resolve the destination without parsing messages. Imported private keys are validated before lookup.

Owner imports return a guarded save scope (`saved`/`existing`, destination ID, operation and acknowledgment callback). Only `{ outcome, libraryId }` crosses the transport after acknowledgment. Destination invalidation cancels acknowledgment; every scope is disposed, including imports interrupted during resolution. Setup waits for pairing to settle before promotion, selects an existing destination locally, then removes only its unfinished receiver after the reply has settled. Other pages retain selection. Lost acknowledgment retains the durable destination and existing uncertainty status.

Verification: `make test-client` passed with local-server access; Svelte check reported zero errors/warnings. `npm run lint --prefix client` passed (RTK's npm lint formatter required `rtk proxy` to display usable output). `make extension` passed without warnings. Focused session/catalog/vault/pairing tests passed, including destination invalidation, invalid-key rejection before lookup, final-write duplicate races, same-origin equivalence and different-origin distinction. Disposable Podman PostgreSQL plus Firefox/Chromium ran 14 focused browser scenarios successfully: normal pairing, additional libraries, duplicate receivers with the destination already selected and with another library selected, for web and extension. IDs, keys, generations, catalog counts and independent page selection were preserved. Existing protocol-vector tests passed in the client suite.

The new browser regression scopes verification-code lookup to Add Library because task 44's duplicate IDs exist when a saved sender and temporary receiver render in the same page. No component/store refactor was needed. Item 36 must preserve the completion contract and acknowledgment-before-receiver-disposal ordering.
