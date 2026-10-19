# Serve the streaming worker source map

## Goal and scope

Remove the developer-tools 404 for the source map referenced by the production
streaming worker. The build already emits streaming-worker.js.map beside the
worker, but the Rust static router exposes only the JavaScript file.

Expose exactly GET/HEAD /streaming-worker.js.map from I2N_WEB_DIR with JSON content
type and the worker's no-cache policy, including conditional 304 responses.
Keep ordinary missing-file 404 and unsupported-method behavior. Do not expose
additional root files or change the plaintext virtual URL namespace.

Exclusions: content CSP/favicon changes, streaming or encryption changes, database
changes, new dependencies, and Vite development changes (its worker has no external
source map). Existing application assets retain their current cache policy.

## Interfaces, ownership and lifecycle

The Rust static router owns the additional public file route. The frontend build
owns generating the worker and matching map. No API schema, credentials, stores,
persistence or session resources change. ServeFile retains ownership of static
response IO and cancellation; no additional asynchronous workflow is introduced.
Missing deployment artifacts return 404 rather than application HTML. Deploy the
rebuilt Rust server with the existing matching frontend artifacts.

## Acceptance checks

- Rust HTTP tests verify map GET bytes, JSON type, no-cache, HEAD length/empty body,
  conditional 304/no-cache, unsupported POST and a missing map's 404.
- Build checks require the map and verify that the worker references it and that
  it is valid source-map JSON.
- Run focused Rust web tests, make test-build, and repository formatting/lint
  checks before committing. No browser visual review is needed for this route-only
  change; existing plaintext handling and UI are unchanged.

## Verification

All five Rust web tests passed, including the new source-map HTTP regression.
`make test-build`, `make lint` and `make format-check` passed without warnings.
