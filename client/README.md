# Web client

Svelte 5, TypeScript, and Vite, using Node from `.nvmrc`. Makefile targets install locked dependencies automatically; direct npm commands require `npm ci` in this directory. `npm run dev` starts Vite; `npm run build` writes unminified files to `dist/web`.

`make extension` installs locked build dependencies and compiles the Firefox bridge
from `extension/` to JavaScript in `dist/extension/`. Installation and configuration are in the [root README](../README.md#firefox-extension).

## Ownership

`src/main.ts` mounts the app through a `data-app` element reference. Each tab loads its session once at startup. Optional remembered access survives refresh and browser restart; otherwise tabs unlock independently. Lock and local identity changes cancel that tab's work. Other tabs keep their in-memory sessions until refreshed or closed; no storage events, polling, or session-sharing channel are used.

`views/Application.svelte` creates the application store, which owns the session,
preferences, pairing, extension receiver, routing, and library workspace. The
workspace survives navigation. Native `#/library`, `#/settings`, and
`#/media/<id>` links navigate without reloading; the routing store observes
`hashchange`. Pure route helpers live in `lib/routes.ts`. Views subscribe to
stores and pass ordinary state and callback props to isolated components.
Components may hold temporary input/focus state; store imports are type-only.
HTML IDs are prohibited. Controls use nested labels and browser tests use
accessible names.

The application also owns the extension receiver store. It accepts files only
in each tab, delegates uploads to the root-owned uploads store, and holds at most one file
hidden in memory while locked, automatically submitting it after unlock. Session invalidation and root disposal discard that file.
The extension sends a native File through a document-owned injected runtime
listener and window.postMessage, with no base64 conversion.
The extension owns capture, persistent app tab creation, focus only when unlocking
is needed, completion notifications, and its saved app URL.

`services/library-api.ts` signs bounded transport requests through the library
identity service (`services/library-identity.ts`), which alone holds the seed
and exposes non-extractable keys. `stores/chain.ts` verifies canonical
signatures, hash links, encrypted operations, and local trusted-head pins before
accepting state, and serializes appends so unrelated writes rebase onto the
current head. `stores/materialized-view.ts` selects live or historical state and
owns metadata indexing. The UI always projects that selection; history uses the
same rendering and search path, with file writes disabled. Current quota,
authentication, and purge availability do not rewind.

`storage/database.ts` and `storage/session.ts` own the password-sealed library
credential and optional remembered unlock key. `storage/chain.ts` separately
stores encrypted records and a monotonic trusted head. Decrypted metadata,
indexes, previews, uploads, and content keys stay in memory. Password changes
replace local protection atomically. Forget removes the credential and its cached
history; Reset removes local credentials and all history caches. Other live tabs
keep their independent in-memory session and trusted head.

The root workspace owns chain synchronization, sequential uploads, quota, and
file resources across navigation. Each file resource owns its preview requests
and URLs. Downloads belong to the root lifetime and survive view navigation;
lock, session replacement, and current purge cancel them. Metadata editors bind
drafts to the file's metadata revision and require explicit review and retry
after a conflicting edit. Failed upload batches retain messages only.

Pairing uses OPAQUE, explicit human verification, and five relay messages. The
sender transfers the shared seed and its trusted checkpoint; the receiver saves
the credential and verifies the full chain through that checkpoint before
acknowledging. Pairing performs no chain writes.

Creation generates the library seed and a library backup sealed under an
automatically generated password; registration happens only after the backup
download starts. Restore verifies history from the backup's checkpoint. See the
[protocol](../doc/protocol.md).

## Logging

Production and development builds write structured events to the browser console:
`[i2nclip] pairing.started` followed by an expandable object. Filter for
`[i2nclip]` or a scope such as `pairing.` or `session.`. Enable Debug in
Firefox or Verbose in Chromium to see intermediate steps, retries, cancellations,
and stale results. Info shows major actions/outcomes; warnings show recoverable
problems and errors show terminal failures. Instance identifiers distinguish
owners; operation numbers correlate work within an owner. Neither is persisted.

Web events appear in the page's developer console. Firefox extension background
events appear in the add-on's console opened through `about:debugging`; injected
bridge events appear in the app tab's extension/content-script context. Extension
options events appear in the options page console. There is no remote collection
or application log storage. Logs omit credentials, codes, payloads, filenames,
tags, URLs, media hashes, and arbitrary error messages/stacks.

## Verification

`npm test` runs unit tests; `npm run check` runs Biome checks (lint, formatting, and import organization) strict TypeScript checks, and the Svelte checker. `npm run fix` applies Biome fixes. Both fail on warnings. `make test-build` and `npm run test:build` build and inspect the web and unpacked extension directories.

`npm run e2e` builds the web app and runs Firefox and Chromium against isolated Rust web/API listeners bound atomically to loopback port 0. It builds the Rust helper executables before launching tests. Set `I2N_TEST_DATABASE_URL` to a disposable PostgreSQL administrator connection, or use root `make test-e2e` to provision one. Tests use the browser UI without runtime shims or private-state hooks. Screenshots use per-test output directories under ignored `e2e/shots/`. See [the test pipeline](../doc/test-pipeline.md).
