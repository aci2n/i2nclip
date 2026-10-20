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

Stores call `lib/api.ts` directly. API and protocol helpers handle encryption, signing, framing, and verification. Session generations and abort signals invalidate stale work. Search revision checks keep pagination tied to the submitted query. Per-item busy state rejects overlapping mutations.

`lib/database.ts` owns native IndexedDB connections and cancelable transactions. `lib/persistence.ts` conditionally replaces one session record containing the encrypted identity/server, revision, derivation material, and optional non-extractable AES-GCM wrapping key. The password and plaintext identity are never persisted. Password changes verify the old password and atomically replace identity encryption and any remembered key. Lock removes remembered access; Forget retains an encrypted empty identity without remembered access; Reset removes the session. Conflicting writes fail with a refresh message. Compression preferences use a separate boolean entry. Session and preference stores close their connections on disposal. Old localStorage data is ignored without migration; reconnect existing setups through recovery or pairing.

The uploads store owns sequential batches and refreshes the submitted library search after completion; only failure messages remain, and users select failed files again through Upload. Progress and completed-file summaries are transient. Uploads, search results, media bytes, and URLs are never persisted. Media items own their requests, decrypted bytes, and URLs and dispose them when deleted, superseded, or locked. Deleted cards remain gray and inactive until a new search.

Pairing uses isolated OPAQUE attempts, explicit verification, and the relay API. Sender, receiver, and progress display have separate components; the store owns the workflow. Recovery exports one identity using an independent password. No migrations or legacy formats are supported.

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
