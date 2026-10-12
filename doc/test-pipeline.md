# Test pipeline specification

This specifies simplification phase 15. Tests must run from a fresh clone with the documented Rust/Node/system prerequisites, isolate their mutable state, and avoid fixed test ports. Application behavior and its production port remain unchanged.

## Preparation and commands

The client Makefile installs locked npm dependencies when `node_modules/.package-lock.json` is absent or older than the package files. Node is resolved from PATH; Makefile targets check the exact version pinned in `.nvmrc` before installing dependencies or running client commands. Builds, static checks, unit tests, and packaging depend on this preparation.

`make test` runs client unit tests, Svelte checking, and Rust unit/configuration tests. `make test-db` provisions PostgreSQL or uses an explicitly supplied disposable administrator connection. `make test-e2e` prepares dependencies, installs Firefox/Chromium, builds the web client and all helper executables, and runs browser tests. `make test-all` runs portable checks, packaging, database tests, and browser tests sequentially. The Linux/Podman process profile is separately requested with `make test-profile`.

Retain one npm build and one packaging command. Remove target aliases and debug variants without distinct behavior. Makefiles delegate client commands; they do not duplicate application build logic.

## Resource ownership

Rust unit/API tests call routers in-process. The Makefile defaults to four concurrent Rust test cases, overridable through `RUST_TEST_THREADS`, so independently isolated fixtures cannot exhaust the shared PostgreSQL connection budget. Explicit concurrency inside race/admission tests is preserved; inspection/admin pools use one connection. Each database test uses a separate database with cleanup guards that run after assertion panics. Unit tests have a sixty-second timeout, and browser waits and held-request cleanup are bounded. Each browser scenario owns its database, server process, and browser context. PostgreSQL containers expose only a randomly selected host port, required for host-based clients. Explicit Docker socket configuration takes precedence; otherwise use the available Docker or Podman socket.

The `test-server` example binds `127.0.0.1:0` before deriving its canonical origin. After initializing the real web/API router, it prints `ready http://127.0.0.1:<port>`. It accepts the fixture database URL through the environment. Browser tests and the resource profile use the reported origin; neither probes or reserves a port in a separate process.

Shared test process helpers discover Cargo's target directory from metadata, execute prebuilt helpers directly, and clear inherited production database-file settings. The server's web directory is explicitly the current clone's build. Startup and cleanup are bounded; failures kill and await only owned processes before dropping the fixture database. There are no cargo-run subprocess wrappers that can leave listeners behind.

Browser startup is prepared before scenario execution. Screenshots use Playwright's per-test output directory, preventing concurrent scenarios and separate projects from overwriting each other's artifacts.

## Acceptance

- Removing dependencies, client dist, and local build artifacts must not require undocumented preparation beyond the listed toolchains and system libraries.
- Unit, PostgreSQL API, package, and Firefox/Chromium suites pass in an independent clone.
- The optional profile passes while an unrelated service owns port 8080.
- Browser tests pass in either project and as individually selected scenarios. Multiple scenarios own different databases and bound listener addresses.
- Failed startup and teardown release owned listeners and processes; no test modifies another fixture's database, storage, or artifacts.

## Fresh clone

Prerequisites are Rust/Cargo, Node 22.23.3 from `client/.nvmrc`, npm, zip/unzip, and Docker or rootless Podman API access. PostgreSQL image downloads and browser downloads need network access. Firefox/Chromium system libraries must be installed; on supported Linux distributions, `cd client && npx playwright install --with-deps firefox chromium` installs them after `npm ci` and may require administrator privileges.

```sh
git clone <repository-url> i2nclip
cd i2nclip
# Install/use the Node version from client/.nvmrc on PATH.
make test-all
# Optional Linux/Podman resource measurements:
make test-profile
```

A disposable PostgreSQL administrator URL may be supplied through `I2N_TEST_DATABASE_URL`; the resource profile always owns its own container. With rootless Podman, start its API socket before running tests. Explicit `DOCKER_HOST` is honored, and the Makefile detects local Docker/Podman sockets when unset. Direct npm browser execution needs an explicit test database URL; the root Makefile provisions one.
