# Store classes and explicit initial reads

## Goal, scope and exclusions

Convert all fourteen modules under client/src/lib/stores to private implementation
classes, preserving structural factory contracts. This supersedes the implementation
rules in store-functions.md and library-class.md. Keep grouped public readonly
bindings above constructors and ordinary private workflow methods. Remove instance
dependency/runtime records, retain operation-local records and pure module helpers.
No inheritance, shared lifecycle framework, new dependencies, rendering changes,
protocol/crypto changes, schema changes or persistence changes.

## Interfaces and ownership

Factories retain arguments and defaults. Private writable state and resources belong
to each instance; services are injected once. Cheap synchronous setup (listeners,
subscriptions and thumbnail URLs) stays in constructors, after callback dependencies
are initialized. Initial network/storage reads are explicit: Library.search,
Tags.refresh, Quota.refresh, MediaViewer.retry, Session.load and Preferences.load.
Session/Preferences load returns and caches initial completion, replacing loaded;
Session.retry remains an explicit retry, and password initialize is unchanged.
Preference saves wait for an in-flight initial load.

Application.start installs coordination subscriptions, then constructs its extension
receiver and launches Session/Preferences loads. Workspace.start launches quota,
tags and library reads. Both are idempotent and cannot restart after disposal.
Application assigns a new workspace before starting it. Views register cleanup
before starting Application or loading MediaViewer. Uploads/Pairing need no startup
method. Streaming worker registration remains lazy within stream operations.

## Persistence, lifecycle and failures

Preserve all current state shapes, messages and command results apart from the
explicit startup changes. Workspace survives navigation until context/session end;
downloads retain session lifetimes and previews retain item lifetimes. Keep batch,
file, pairing-task, stream-request and wait records local to their own operations.
Preserve cancellation, stale-result checks, busy rejection, sequential uploads,
per-file continuation, metadata conflicts and stream concurrency limits.

Dispose must handle construction without initial reads, partial activation,
repeated disposal and late async completion. Ended lifetimes cannot launch initial
work. Set startup guards before synchronous subscriptions; detach resources if
synchronous setup fails. Stable listeners must be removed with their original
references. Independent instances/tabs share no mutable runtime state.

## Acceptance and commits

Commit cohesive groups after focused tests, client checks and warning-free builds:
simple stores; uploads/content streams; media/library; session/pairing; root
coordination. Update owners and fixtures with each startup change. Add meaningful
public-interface tests for construction without initial I/O, explicit/cached loads,
detached callbacks, independent instances, duplicate starts, synchronous notification
ordering and disposal before/during startup. Keep existing lifecycle regressions.
Use the Node version in client/.nvmrc. Final verification: make test,
make test-build and make test-e2e with the real local API, isolated databases and
Firefox/Chromium contexts. Record actual verification results and any blockers.

## Implementation and verification result

All fourteen stores now use private classes. Public commands bind ordinary private
methods; initial network/storage work is explicit at its owning call site. Cheap
synchronous listeners and thumbnail setup remain in constructors. Application and
Workspace expose idempotent start methods; Session/Preferences expose cached load
promises instead of loaded properties. Existing retry and password setup commands
remain distinct. Streaming registration remains lazy.

Added public-interface regressions for explicit/cached loads, inactive construction,
disposal before reads, duplicate starts, already-aborted workspace contexts,
receiver setup failure and disposal during synchronous startup notification.
Existing detached-callback, independent-instance and async lifetime tests remain.

Verification used Node 22.23.3 from client/.nvmrc:

- make test: all 37 client test files, Biome/TypeScript/Svelte checks with zero
  errors/warnings, 42 Rust library tests, three main tests and five configuration
  tests passed. The main suite retains its subprocess-fixture ignore.
- make test-build: web and unpacked extension builds and content checks passed.
- make test-e2e: 135 Firefox/Chromium cases passed in 6.3 minutes, with the existing
  Firefox worker-termination skip. Both browsers verified transfers above 1 GiB,
  native seeking, cancellation, remembered sessions, pairing, extension captures
  and navigation-independent uploads/downloads. Browser launchers emitted their
  existing NO_COLOR/FORCE_COLOR environment notices.

The sandboxed browser command could not reach the local Podman API socket. The
same make test-e2e command passed with expanded access to Podman, browser processes
and loopback test listeners. Tests used their owned PostgreSQL container and
isolated per-case databases/browser contexts.
