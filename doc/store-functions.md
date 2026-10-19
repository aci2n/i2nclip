# Explicit store workflow dependencies

## Goal and scope

Refactor every module in `client/src/lib/stores` so substantive functions live at
module scope and receive explicit dependencies. Factories assemble instance state,
resolve defaults, wire callbacks, start existing initialization, and return the
unchanged public interface. Keep trivial forwarding wrappers, state updater
expressions, and Promise settlement adapters inline.

Use private store-specific dependency and runtime records. Dependencies hold fixed
services/inputs; runtime holds mutable instance state and owned resources. Small
helpers receive narrower inputs. Keep helpers in their existing modules, grouped
by workflow, with no shared framework, classes, unchecked initialization casts, or
mutable module-level state. Initialize records before synchronous callbacks run;
retain stable listener references for removal.

## Interfaces and ownership

Preserve exported factories, options, methods, getters, subscriptions, return
values, default services, messages, and logging. New records/helpers are private.
Maintain distinct store, command, batch/file, pairing-task, media-preview, and
stream-request lifetimes. Async work reads live runtime records; only existing
operation inputs are snapshotted. Functions must not discover dependencies through
an application/workspace container.

The application continues owning workspace stores across Library/Settings
navigation and content streams for the unlocked session. Media previews retain
item lifetimes; downloads retain session lifetimes. Stream requests retain their
own ports, busy/closed flags, cancellation, and timers, with two reads allowed
across the session. Uploads remain sequential and each file keeps its own progress
completion guard and prepared name.

## Persistence, cancellation, and failures

No changes to UI, service-worker implementation, protocol, crypto, API requests,
persisted formats, database schema, dependencies, or storage policy. Preserve all
existing cancellation, stale-result checks, busy rejection, failure messages,
initialization order, synchronous notifications, and cleanup ordering. Separate
instances/tabs/requests/tasks must never share mutable runtime state. Retain upload
continuation after per-file failure, pairing expiry/approval/retry behavior, and
session invalidation. Never publish stale results or revive disposed resources.

## Stages and acceptance

Make cohesive commits for: (1) quota/tags/preferences/routing, (2) uploads,
(3) content streams, (4) media item/viewer/library, (5) session/pairing,
(6) extension receiver/workspace/application. Each stage passes focused existing
tests, `make -C client check`, and `make client` without warnings.

Retain public-interface tests for superseded searches and pagination, late upload
callbacks, metadata conflicts, session invalidation, pairing cancellation/expiry,
stream cancellation/timeouts, and navigation-independent downloads. Add behavioral
regressions only where coverage is missing for independent live instances,
concurrent stream-request cleanup, and synchronous initialization. Tests isolate
and clean up their mutable resources on success and failure.

Use Node from `client/.nvmrc`; final checks are `make test`, `make test-build`, and
`make test-e2e` against the real local server with isolated databases/browser
contexts. Review all stores for remaining nested workflows. Acceptance requires
short assembly factories, explicit substantive-helper dependencies, unchanged
public interfaces, and passing checks without warnings.

## Verification

All six stages passed their focused tests, client checks, and web builds. Final
review found only trivial adapters, state updates, and Promise settlement wiring
nested inside workflows.
State records use Svelte's `Writable` type directly; operation records remain
private to their owning store modules.

Added public-interface regressions for independent quota instances sharing an API,
concurrent stream requests and queued-read cancellation, and synchronous
application initialization (including channel setup failure) and navigation cleanup.

`make test` passed the client suites and checks, 42 Rust library tests and five
configuration tests. `make test-build` passed web/extension build verification.
The final fixture-only adjustments also passed their focused tests and client
checks with zero Svelte errors or warnings.

An initial browser run was invalidated when an active Playwright download and
Rust test helpers disappeared (`ENOENT`). Verification was repeated with isolated,
ignored build and temporary directories, using the same real-server tests:

```sh
mkdir -p client/dist/store-browser-tmp
CARGO_TARGET_DIR="$PWD/client/dist/store-test-target" \
TMPDIR="$PWD/client/dist/store-browser-tmp" make test-e2e
```

The isolated full browser run passed 127 cases, with the existing Firefox-only
worker-termination skip. Both browsers verified native seeking, cancellation,
worker/session lifetimes, byte-exact downloads above 1 GiB, and encrypted uploads
above 1 GiB surviving navigation. Playwright emitted its existing
`NO_COLOR`/`FORCE_COLOR` environment notices.
