# Project conventions

## Change discipline

- Before implementing future changes, require a detailed written specification, such as a change specification under `doc/`. It must state the goal, scope, explicit exclusions, affected interfaces and ownership, persistence and lifecycle behavior, failure/cancellation cases, and acceptance checks. Resolve facts by inspecting the repository; ask only about missing decisions. An unambiguous authorized request plus documented repository facts can supply the specification; do not add another approval gate to work already authorized.
- Strictly preserve the simplification principles: do the minimal thing that achieves the specified goal, organize code for human readers, and keep responsibilities isolated. Do not add speculative abstractions, capabilities, state persistence, compatibility layers, or dependencies.
- The client is one web app with one unnamed library. Views are the containers for components. Every component must have one presentation responsibility, use only ordinary props/callbacks, and have no store access, storage access, or async application workflow. Local presentation state is allowed. HTML IDs are forbidden everywhere.
- Stores own asynchronous workflows, cancellation, and resources. Keep protocol functions independent of rendering. Preserve root-owned work across navigation and dispose it when the owning session ends.
- Prefer private TypeScript implementation classes for stateful stores and resource-owning services, with structural factory contracts, bound public commands, and ordinary private workflow methods as documented in `doc/store-classes.md`. Keep stateless protocol/crypto transformations as functions; do not put instance state in factory closures.
- Treat data formats and schema as greenfield. Implement the current specification directly; do not invent legacy fallback behavior. Database changes use the SQLx migration workflow below.
- Make small frequent commits after cohesive changes build without warnings. Focus on refactoring before running the final test suites. Tests must cover meaningful behavior and invariants rather than mirror implementation details. Test quality is mandatory.
- Every test must isolate its mutable state and resources. Bind test listeners atomically to loopback port 0, use isolated databases and browser contexts, and clean up owned resources on success and failure. Verification commands must work from a fresh clone with documented toolchain/system prerequisites; never rely on developer-specific paths or existing build artifacts.

- Group Rust imports by crate within each scope and visibility, separating standard-library, external, and project imports. Prefer importing symbols at the top of the file and using their unqualified names in signatures and code (for example, `RegistrationRequest` rather than `auth::RegistrationRequest`). Keep explicit qualification for ambiguous names. Client imports follow Biome ordering. Use the Makefile Rust formatting commands to enforce grouped imports; client `check`/`fix` run Biome checks and fixes.

## Layout and commands

- The server image includes only the web client build, served by Rust on port 8080 alongside the API. `I2N_WEB_DIR` defaults to `client/dist/web` locally and is set to `/usr/local/share/i2nclip/web` in the image.
- The Rust server lives in `src/`. Frontend source, npm tooling, and browser tests live in `client/`.
- `client/` is a Svelte 5 + Vite web project. Reusable crypto, API, media, stores, and components live in `client/src/lib/`.
- Keep one npm project: package.json, lockfile, .nvmrc, and Playwright configuration belong in `client/`.
- The root Makefile delegates frontend commands with `$(MAKE) -C client`; do not include the client Makefile. `make build` builds server and frontend; `make client` builds frontend.
- All web and unpacked extension build outputs stay in `client/dist/`. No ZIP packaging.
- Do not minify JavaScript or CSS unless explicitly needed. The Vite build disables minification.

## Database policy

- Database startup runs embedded SQLx migrations from `sql/`. For the explicitly authorized blockchain-storage cutover, replace `sql/001_init.sql` directly and use fresh databases; no data conversion, compatibility paths, or follow-up migration for the old schema. After that baseline is established, keep applied migrations unchanged and add numbered SQL files for subsequent schema changes. Do not add legacy-schema detection or compatibility migrations without an explicit requirement.
- SQL `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are fine; reopening a current database must preserve its data.

## State and resource ownership

- Views subscribe to stores and pass plain state and callback props to components. Components must not receive or import stores. Stores own async workflows; components may own presentation state. HTML `id` attributes are forbidden.
- The application forwards the specific stores each view needs as explicit props. Child views must not receive or read their owning workspace/container to discover dependencies; Settings receives quota and uploads directly from the application.
- Keep library, uploads, and quota stores owned by the workspace at the app root while navigating between Library and Settings so active uploads, their status, and quota reads survive view changes.
- Use `$state` for bound DOM references read by template handlers. Run the Svelte checker and ensure `make client` builds without warnings.
- Search uses cancellation plus stale-result checks. Pagination belongs to the submitted search and allows only one request at a time.
- Identity or server changes invalidate pending library operations. Upload batches run sequentially and individual failures do not stop the batch. Upload state exists only in memory.
- A failed file must not stop the rest of a batch. Retain only failure messages, let users select failed files again through Upload, clear messages on identity/server changes, and ignore progress from completed or superseded uploads.
- Allow independent tabs; each loads its session once at startup from IndexedDB. Other tabs retain live access until closed or refreshed. Do not add cross-tab notifications, polling, focus checks, or locks. Reject overlapping session and media-item mutations with local busy state.
- Media items own decrypted bytes and object URLs. Abort requests and revoke URLs on disposal; stale downloads must not create URLs or open save dialogs.
- Check local file size before reading bytes. Cap content downloads while streaming; do not trust Content-Length alone.
- Preserve the encryption protocol when reorganizing code. Rust and JavaScript share `client/tests/test-vectors.json`; v2 uploads use random file IDs and content keys wrapped in immutable descriptors, metadata binds its file ID, and downloads authenticate each complete chunk with file/position/dimension AAD before exposing plaintext.

## UI conventions and visual review

- Keep component-specific styles in Svelte `<style>` blocks. `client/src/app.css` owns theme tokens, base typography, and shared controls/layout primitives; avoid global selectors that reach into another component. Keep the look simple and consistent, with light/dark themes. Use rem spacing on a .25/.5/.75/1/1.5/2/3 scale, with .125/.375 for compact chip padding; keep tag labels, inputs, and actions separated by explicit gaps.
- Place progress, success, and error messages beside the action that produced them. A status at the bottom of settings can fall below the viewport, especially on narrow screens.
- Use a consistent preview area for images, audio, video, and ordinary files. Mixed aspect ratios otherwise create large gaps in the grid. Preserve the media's aspect ratio within the preview.
- Optimize cards for browsing: readable tags, short format/size summaries, and a disclosure for detailed metadata.
- Edit tags inline: a + button opens an input, Enter saves a chip, Escape cancels, and chips have removal controls. Keep failed drafts, restore focus after saving, and deduplicate by protocol normalization while preserving the first spelling.
- Distinguish an empty library from a search with no matches; provide an upload action or a clear-search action respectively.
- Make Create/Restore the main setup choices. Keep server configuration in a disclosure.
- Inspect actual Firefox screenshots after visual changes. Test realistic landscape/portrait/panorama media, audio and files, long names, errors, both themes, and narrow widths such as 320/360 px. A one-pixel fixture does not reveal card-layout problems.

## Verification

- Run the smallest relevant verification after each cohesive change. Backend-only changes do not run frontend tests or checks; frontend-only changes do not run backend suites. Shared protocol changes run the affected tests in both languages. Documentation-only changes need a diff/consistency review, not application builds or tests.
- Do not run E2E tests after each change. Group browser tests and required screenshot inspection into final integration verification, unless a specific browser-only failure requires a focused test. Run the full portable suite once after integration; repeat or broaden checks only for new changes, failures, or unresolved concerns.
- Scope formatting, static analysis, and warning-free builds to the affected subsystem. Pre-commit tooling must follow this policy rather than invoking unrelated checks. Keep verification sequential when jobs share build outputs, especially `client/dist/`.
- Use Node from `client/.nvmrc` on PATH. Client Makefile targets prepare locked dependencies automatically; `npm ci --prefix client` is also available for direct npm commands.
- The root Makefile groups all test/verification targets by required access. `make test-build` builds the web and unpacked extension and checks their contents without a browser or database.
- `make test` runs client tests, the Svelte checker, and Rust tests. `make -C client test` checks only the client.
- `npm run e2e --prefix client` rebuilds the web app and runs Firefox/Chromium tests. `make test-e2e` also installs dependencies, Firefox/Chromium, and builds the helper executables.
- E2E tests use the real local Rust web/API listener without runtime shims. Screenshots use per-test directories under ignored `client/e2e/shots/`; inspect them with the image-viewing tool.
- Browser tests need permission to launch Firefox and communicate with local servers. If sandboxing blocks them, rerun with the appropriate escalation.
