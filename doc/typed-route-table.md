# Typed route definitions

## Goal, scope and exclusions

Make one ordered table in lib/routes.ts own matching, parameter extraction,
canonical URLs and workspace requirements. Derive navigation types from this
table, preserving routeHref({ page, ...params }) and navigate(route, replace).
No URL, rendering, server, protocol, storage, dependency or compatibility changes.
No dynamic view registry or general-purpose routing framework.

## Interfaces and ownership

A local defineRoute helper connects an extractor's return type to its URL
builder's input and preserves literal page/workspace values. Each entry contains
match, page, workspace, params(match), and href(params). Match Media first,
Settings second, then catch-all Library. Media retains missing/malformed IDs for
existing view validation. Derive Route (page and parameters) and ResolvedRoute
(page, parameters and literal workspace flag). parseRoute returns ResolvedRoute;
routeHref and navigate accept Route. Keep any heterogeneous dispatch assertion
inside the implementation, never at callers.

The routing store owns browser events, history and disposal without recognizing
specific pages. Views retain rendering decisions and import only pure route
helpers and store types in components. Application checks resolved workspace
metadata rather than a Media page exclusion.

## Persistence and lifecycle

workspace permits creation of a missing workspace; it never disposes an existing
one on navigation. Context replacement/root teardown still dispose workspaces.
Keep native hashes, synchronous programmatic publication, duplicate suppression,
viewer lifetime, fresh viewer tabs avoiding browsing reads and extension handoff
ordering. No new persistence or resource owners.

## Failures and cancellation

Unknown/empty hashes select Library through the final definition. Missing or
malformed Media IDs retain the existing local error and cannot trigger media
requests. Existing upload failure, cancellation and stale-result behavior is
unchanged. Parser and formatter do not perform async work or own resources.

## Acceptance checks

Compile-time checks establish required string IDs for Media, rejection of unknown
pages and ID fields on static routes, workspace-free navigation inputs, and
page-based narrowing of parameters and literal workspace flags. Runtime tests
cover ordered matching, fallback, malformed targets, canonical URLs, round trips
and resolved metadata. Retain routing lifecycle tests. Run client tests/checks,
a warning-free client build, and Firefox/Chromium navigation, deeplink,
upload-survival, file-drop and extension coverage with isolated resources.
