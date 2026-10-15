# Focused regression tests

## Goal, scope, and ownership

Add three focused checks for current metadata and fullscreen preview behavior.
The metadata codec test inspects the wire JSON independently of its decoder,
including camelCase schema fields, arbitrary nested keys, and thumbnail bytes.
The library test drives real store workflows through injected deferred HTTP
requests to check mixed-media pagination and closing during pending work.
The browser test uploads real video/audio to the local Rust API and retains
native player handles to verify playback stops on navigation and close.

## Lifecycle, persistence, and failure

No production interfaces or persistence change. Fixtures own their stores,
object URLs, browser contexts, loopback listeners, and isolated databases using
existing cleanup helpers. Held requests are resolved even on assertion failure.
Preview cancellation must suppress reopening after late page/download results;
closing need not cancel shared cached downloads or pagination. Assert actual
native playback, without replacing play/pause or installing runtime shims.

## Exclusions and acceptance checks

No broad coverage matrix, snapshots, speculative helpers, production refactoring,
or visual changes. Extend the existing codec test; add one store workflow test
and one browser workflow test. Verify exact camelCase JSON independently, intact
unknown keys/thumbnail and input, submitted-query pagination through file-only
pages, one pending pagination request, audio/video eligibility, and no reopening
after close. Verify a playing video pauses when navigating to audio and the
playing audio pauses on close, in Firefox and Chromium. Run client tests/checker,
build, and the focused real-server browser test using documented prerequisites.

## Verification

The full client unit suite, Svelte checker, production build, and changed-file
Biome checks pass. The playback case passes three consecutive runs in each of
Firefox and Chromium (six runs), with real API listeners and isolated databases.

With Node from client/.nvmrc on PATH, the documented browser prerequisites, and
a working Docker/Podman API socket (DOCKER_HOST if needed), run from the root:

```sh
npm ci --prefix client
npm test --prefix client
npm run check --prefix client
npm run build --prefix client
cargo build --bin i2nclip --example test-server --example test-database
cargo run --quiet --features test-containers --example postgres-tests -- client/node_modules/.bin/playwright test --config client/playwright.config.js playback.spec.js --repeat-each=3
```

The playback case reads the displayed order before choosing an arrow direction:
upload timestamps have second precision, so ID tie-breaking can put either
fixture first. No sleep or fixed sort-order assumption is required.
