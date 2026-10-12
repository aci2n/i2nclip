# Implementation plan: item 38 — Remove saved-server URL editing

## Goal

Do not allow changing the server URL of an existing saved library. Continue accepting a URL during OTC creation and pairing.

## Changes

- Remove the Server settings disclosure and update action from the configured Settings view and remove the `serverControls` render prop from `ManageLibraries`.
- Keep the saved server shown as read-only text in the configured-library summary and Manage Library context where useful.
- Retain the URL inputs for OTC creation and pairing; authorization continues to use its selected authorizer's server.
- Remove now-unused settings-store/server-update UI paths only if they are exclusively used by the removed saved-library editor. Preserve server validation for setup and pairing.

## Acceptance

- Browser tests assert no editable URL appears for a configured library, while OTC and Pair still accept and use a server URL.
- Confirm authorizing a new library uses the authorizer's server and switching saved libraries shows each saved URL correctly.
- Run client tests, Svelte check, lint, and focused settings/pairing browser tests.
