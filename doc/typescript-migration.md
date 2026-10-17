# Web and extension TypeScript migration

## Goal and scope

Convert maintained JavaScript in the web application, Firefox extension, unit and
browser tests, and their configuration/build scripts to strict TypeScript. Keep
one npm project and the pinned Node runtime. Desktop sources and leftover native
artifacts are excluded. No product changes, routing changes, multi-tab support,
protocol changes, database migrations, or new runtime dependencies are included.

## Interfaces and ownership

Type protocol values, API inputs/results, identity and crypto contexts, store
snapshots and operation handles, component props/callbacks, browser events, and
injected test dependencies. Keep types with their owning subsystem. Decoded
external values remain unknown until narrowed or validated against the current
protocol. Types do not replace runtime validation.

Views subscribe to stores and pass plain state/callbacks to presentation
components. Stores continue owning asynchronous workflows, cancellation and
resources. Root-owned work survives navigation; session disposal cancels work.
Media items retain ownership of bytes, requests and object URLs. No HTML IDs.

## Persistence and failures

Preserve localStorage keys and records, MessagePack wire shapes, cryptographic
purpose/AAD values, hash verification, and shared Rust/JavaScript vectors.
No migrations or compatibility behavior. Preserve stale-result checks, abort
handling, identity invalidation, resource cleanup, failed persistence behavior,
and sequential uploads that continue after individual failures.

## Implementation

Use strict browser, Node/tooling and extension compiler configurations, sharing
base options. Use erasable TypeScript and explicit .ts imports; Node runs scripts
and unit tests directly. Vite bundles the web app. Compile extension scripts to
JavaScript under dist/extension, rewriting relative import extensions while
preserving manifest entrypoints and classic content-script execution. Do not
minify. Convert protocol/helpers, API/persistence, stores, Svelte scripts, and
related tests in cohesive buildable commits. Remove temporary JavaScript support
at completion. Exclude native artifacts from all discovery and checks.

## Acceptance

All scoped maintained JavaScript is converted or removed. Biome, strict
TypeScript and Svelte checking pass without warnings. Unit tests and shared crypto
vectors pass. Web and extension build-content checks pass, including executable
extension script layout. Firefox/Chromium integration suites pass with the real
Rust listener and isolated resources. Existing lifecycle, cancellation, stale
result and URL disposal tests remain meaningful. Verification uses Node from
client/.nvmrc, locked npm dependencies and the documented Rust/PostgreSQL/browser
prerequisites; no developer-specific paths or preexisting artifacts are required.

## Interface and lifecycle review

After committing the compiler-clean migration, review the whole web/extension
implementation and tests for type shortcuts. Replace ad hoc Pick/Omit dependency
slices with named contracts owned by the subsystem that provides the capability.
Keep interfaces small and concrete; do not add a generic dependency framework.
Use optional properties only for optional inputs and absent data, not for resources
that every running workflow requires. Represent pairing phases with their actual
phase-specific data. Keep pre-room cancellation, late-room cleanup, durable-save
acknowledgment, disposal during crypto, and session invalidation intact.

Replace generic required-value assertions with local narrowing or explicit data
flow. Persistence should own a validated record, and cached content should be
passed directly to consumers rather than re-read through a nullable closure.
Review component props, test doubles and deferred helpers too. Preserve all wire
and persistence formats and user-visible behavior; no product or protocol changes.
Acceptance remains strict checking, unit/build checks, the shared crypto vectors,
and real Firefox/Chromium integration tests. Commit cohesive reviewed changes
separately from the migration.
