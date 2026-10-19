# Inline source maps

## Goal and scope

Supersede worker-source-map.md: embed production web application and streaming
worker source maps in their JavaScript instead of emitting separate .map files.
Remove the dedicated /streaming-worker.js.map route from the Rust web router.
Exclude extension output, development worker behavior, UI, APIs, encryption,
database changes, dependencies and changes to existing asset cache policies.

## Interfaces, ownership and lifecycle

Vite owns app map generation; buildStreamingWorker owns worker map generation.
Production builds use inline maps; the in-memory development worker still omits
maps. The Rust router continues serving worker JavaScript with no-cache and
hashed assets with immutable caching. The removed map URL returns 404 even if an
old map exists on disk. No persistence, session, cancellation or resource ownership
changes are introduced. Existing build failures propagate normally; missing
static files retain their existing error behavior.

## Acceptance checks

Build checks decode inline maps from every emitted web JavaScript file, require
source-map version 3 and nonempty sources, and reject separate map artifacts.
Rust routing checks require GET and HEAD on the removed URL to return 404 even
with a map fixture on disk. Run make test-build, focused Rust web tests, client
checks and Rust formatting checks. No visual changes require browser review.
