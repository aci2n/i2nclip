# Test pipeline

Tests run from a fresh clone with the documented toolchains and system prerequisites. Each fixture isolates its mutable state and resources; test listeners bind loopback port 0.

## Preparation and commands

After each change, run only the affected tests and subsystem checks. Backend-only
work uses filtered Rust/database tests; frontend-only work uses selected client
tests. Shared protocol changes check both implementations. Documentation-only
changes need no application tests. Run browser suites and required screenshot
review at final integration, and run `make test-all` once rather than after each
commit, unless a particular failure requires a focused rerun.

`make pre-commit` checks staged paths without rewriting the working tree. Rust,
SQL, and Cargo changes select `make format-check lint-rust`; client changes
select `make lint-client`; shared vectors and root build configuration select
both. Markdown changes select neither. `make test-hooks` verifies this dispatch
in an isolated Git repository with a fake checker, without compiling applications.
Explicit formatting targets are `make format-write-rust` and
`make format-write-client`; `make format-write` still runs both.

The client Makefile installs locked npm dependencies when `node_modules/.package-lock.json` is absent or older than the package files. Node is resolved from PATH; Makefile targets check the exact version pinned in `.nvmrc` before installing dependencies or running client commands. Builds, static checks and unit tests depend on this preparation.

`make test` runs client unit tests, Biome/TypeScript/Svelte checks, and Rust unit/configuration tests. `make test-db` provisions PostgreSQL or uses an explicitly supplied disposable administrator connection. `make test-e2e` prepares dependencies, installs Firefox/Chromium, builds the web client and all helper executables, and runs browser tests. `make test-all` runs portable checks, build-output checks, database tests, and browser tests sequentially. The Linux/Podman process profile is separately requested with `make test-profile`.

`make test-build` builds and checks the web and unpacked extension directories; no ZIP packaging is used. `make lint` runs all-target/all-feature Clippy with warnings denied and client Biome/TypeScript/Svelte checks. `make format-check` verifies Rust formatting/import grouping. `make format-write` applies Rust formatting and Biome fixes. Makefiles delegate client commands to the single npm project.

The web app, extension, tests, and build scripts use strict TypeScript. Browser, Node/tooling, and extension configurations share `client/tsconfig.base.json`; native artifacts are excluded. Node runs erasable `.ts` scripts and tests directly. Vite builds the web app; `tsc` emits the unpacked extension and rewrites relative `.ts` imports to `.js`. Generated assets remain unminified JavaScript. `make -C client check` checks all three environments and Svelte components without emitting files.

## Resource ownership

Rust unit/API tests call routers in-process. The Makefile defaults to four concurrent Rust test cases, overridable through `RUST_TEST_THREADS`, so independently isolated fixtures cannot exhaust the shared PostgreSQL connection budget. Race and admission tests retain explicit concurrency inside each case. Each database test uses a separate database with cleanup guards that run after assertion panics. Client unit tests have a sixty-second timeout, and browser waits and held-request cleanup are bounded. Each browser scenario owns its database, server process, and browser context. PostgreSQL containers expose only a randomly selected host port, required for host-based clients. Explicit Docker socket configuration takes precedence; otherwise use the available Docker or Podman socket.

The `test-server` example binds `127.0.0.1:0` before deriving its canonical origin. After initializing the real web/API router, it prints `ready http://127.0.0.1:<port>`. It accepts the fixture database URL through the environment. Browser tests and the resource profile use the reported origin; neither probes or reserves a port in a separate process.

Shared test process helpers discover Cargo's target directory from metadata, execute prebuilt helpers directly, and clear inherited production database-file settings. The server's web directory is explicitly the current clone's build. Startup and cleanup are bounded; failures kill and await only owned processes before dropping the fixture database. There are no cargo-run subprocess wrappers that can leave listeners behind.

Browser startup is prepared before scenario execution. Screenshots use Playwright's per-test output directory, preventing concurrent scenarios and separate projects from overwriting each other's artifacts.

## Reliability checks

Session tests cover same-tab Create recovery after lost registration replies and
storage failures, reuse of the original key, failed registration checks, rejected
invitations and invalidation. Server tests use paused time to verify admission and
body ownership, including unpolled responses and reads past the former response
lifetime limit. The shutdown subprocess fixture verifies nonzero termination despite
a detached blocking task; its parent bounds waiting and kills/reaps it on failure.

## Mobile layout checks

`make test-e2e` (also included in `make test-all`) runs the mobile tag-editor
scenario in Firefox and Chromium at 320 and 360 px. It checks that add, save,
cancel, and remove icons are centered within one CSS pixel of their buttons,
that touch targets are at least 44 × 44 CSS pixels, and that long tags and inputs
do not overflow. It also verifies failed drafts, duplicate normalization, focus
restoration, and preview controls outside the text panel. Per-test screenshots
capture the add control and populated/error editor in light and dark themes;
inspect the Firefox images after layout changes.

The preview gesture scenario sends touch pointer sequences through the real dialog
in both browsers. It verifies left/right navigation within loaded results, upward
close and focus restoration, short/diagonal/canceled/multitouch rejection, and
preservation of buttons, video controls, and vertical text scrolling. Chromium
also verifies navigation using native touchscreen input.

The stalled-preview scenario holds real API responses and verifies immediate
selection, arrows/keys/swipes during loading, cancellation on navigation/close,
rapid return to a canceled item, Retry, and cached-content reuse. It captures
loading states at desktop and 320 px in both themes. Store tests additionally
verify shared item progress and suppression of late results, errors, and cleanup.

Toolbar scenarios verify explicit tag submission, file-picker uploads without
submitting a search draft, clearing an applied filter, focus restoration, and
44-pixel controls at 320/360 px. Screenshots cover both themes with active/cleared
filters, a long upload filename, progress, and a partial-failure summary. Completed
filenames stay collapsed until requested; dismissing successes preserves failures.

## Acceptance

- Removing dependencies, client dist, and local build artifacts must not require undocumented preparation beyond the listed toolchains and system libraries.
- Unit, PostgreSQL API, build-output, and Firefox/Chromium suites pass in an independent clone.
- The optional profile passes while an unrelated service owns port 8080.
- Browser tests pass in either project and as individually selected scenarios. Multiple scenarios own different databases and bound listener addresses.
- Failed startup and teardown release owned listeners and processes; no test modifies another fixture's database, storage, or artifacts.

## Fresh clone

Prerequisites are Rust/Cargo 1.99.0 with rustfmt 1.10.0 and Clippy, Node 22.23.3 from `client/.nvmrc`, npm, and Docker or rootless Podman API access. PostgreSQL image downloads and browser downloads need network access. Firefox/Chromium system libraries must be installed; on supported Linux distributions, `cd client && npx playwright install --with-deps firefox chromium` installs them after `npm ci` and may require administrator privileges.

```sh
git clone <repository-url> i2nclip
cd i2nclip
# Install/use the Node version from client/.nvmrc on PATH.
make test-all
# Optional Linux/Podman resource measurements:
make test-profile
```

A disposable PostgreSQL administrator URL may be supplied through `I2N_TEST_DATABASE_URL`; the resource profile always owns its own container. With rootless Podman, start its API socket before running tests. Explicit `DOCKER_HOST` is honored, and the Makefile detects local Docker/Podman sockets when unset. Direct npm browser execution needs an explicit test database URL; the root Makefile provisions one.

Tag search checks cover local autocomplete, keyboard selection, multiword chips, immediate AND filtering, clear-all and 320/360px layouts in both themes. Automatic-tag checks exercise the 40-tag cap and six-tag card disclosure. Catalog unit/database tests cover label authentication, partial corruption, owner isolation and session cancellation.

Tag-editor browser checks verify immediate selection saves, retained failed drafts, exclusion of assigned tags, catalog cleanup after the final use, partial-corruption warnings and retry. Inspect suggestion menus and long tag chips in Firefox at 320/360px in both themes.

UI consistency checks cover setup modes, expanded settings and nearby errors, lock/admission gutters, mixed media, filename editing and preview icons at desktop and 320/360px. Mobile controls retain 44px minimum targets and readable input fonts. Preview/About screenshots capture the viewport; page-layout screenshots capture the full page. Autocomplete tests exercise wheel containment and Tab/arrow scrolling to the last result, including short viewports.
