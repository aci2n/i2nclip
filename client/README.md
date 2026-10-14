# Web client

Svelte 5 and Vite, using Node from `.nvmrc`. Makefile targets install locked dependencies automatically; direct npm commands require `npm ci` in this directory. `npm run dev` starts Vite; `npm run build` writes unminified files to `dist/web`. `make web` packages `dist/i2nclip-web.zip`.

`make extension` copies the plain Firefox bridge from `extension/` to
`dist/extension/` and packages `dist/i2nclip-extension.zip`, without npm
dependencies. Installation and configuration are in the [root README](../README.md#firefox-upload-bridge).

## Ownership

`src/main.js` mounts the app through a `data-app` element reference. The root acquires an origin-scoped Web Lock for tab admission before reading saved state or creating application stores. Restored pages reacquire admission and start a fresh locked session.

`views/Application.svelte` owns one session, library, and pairing store. The library survives navigation between Library and Settings. Views subscribe to stores, control workflows, and pass ordinary state and callback props to isolated components. Components may hold temporary input/focus state; they never receive or import stores. HTML IDs are prohibited. Controls use nested labels and browser tests use accessible names.

The application also owns the extension receiver store. It accepts files only
after tab admission, delegates uploads to the library, and holds at most one file
hidden in memory while locked, automatically submitting it after unlock. Session invalidation and root disposal discard that file.
The extension owns capture, focus only when unlocking is needed, temporary popup
closure after successful uploads, and its saved app URL.

Stores call `lib/api.js` directly. API and protocol helpers handle encryption, signing, framing, and verification. Session generations and abort signals invalidate stale work. Search revision checks keep pagination tied to the submitted query. Per-item busy state rejects overlapping mutations.

`lib/persistence.js` atomically saves one JSON record under `i2nclip.identity` in localStorage. A master-password-derived, non-extractable AES-GCM key encrypts the identity and server. Decrypted keys remain in memory. Locking releases references and invalidates work; password changes verify the current password and replace the encrypted record. Storage failures preserve the previous record and are shown beside the action.

Uploads are sequential; only failure messages remain, and users select failed files again through Upload. Progress and completed-file summaries are transient. Uploads, search results, media bytes, and URLs are never persisted. Media items own their requests, decrypted bytes, and URLs and dispose them when deleted, superseded, or locked. Deleted cards remain gray and inactive until a new search.

Pairing uses isolated OPAQUE attempts, explicit verification, and the relay API. Sender, receiver, and progress display have separate components; the store owns the workflow. Recovery exports one identity using an independent password. No migrations or legacy formats are supported.

## Verification

`npm test` runs unit tests; `npm run check` runs the Svelte checker; `npm run lint` and `npm run format:check` provide static checks. `make test-packages` and `npm run test:package` build and inspect the web and extension ZIPs.

`npm run e2e` builds the web app and runs Firefox and Chromium against isolated Rust web/API listeners bound atomically to loopback port 0. It builds the Rust helper executables before launching tests. Set `I2N_TEST_DATABASE_URL` to a disposable PostgreSQL administrator connection, or use root `make test-e2e` to provision one. Tests use the browser UI without runtime shims or private-state hooks. Screenshots use per-test output directories under ignored `e2e/shots/`. See [the test pipeline](../doc/test-pipeline.md).
