# Implementation plan: item 45 — Make Pairing presentational

## Goal

Keep Pairing focused on rendering state and invoking callbacks. Parent views own subscriptions to session and pairing stores and pass plain values and actions to the component.

## Changes

- Replace Pairing's store-valued `session` and `pairing` props with plain state snapshots and explicit callbacks for send, receive, approve, reject, and cancel.
- Have the Settings view read the pairing/session stores and pass plain pairing props to both the standalone Pairing instance and through Setup to its embedded Pairing instance. Pass server, busy/disabled state, status, codes, and configured state explicitly.
- Keep form-local input and disclosure state inside Pairing; it does not own service workflow state.
- Review other components that subscribe to stores directly. Record candidates, but only convert additional components where the view can own the state without expanding this change into a broad rewrite.

## Acceptance

- Unit tests exercise Pairing rendering and callbacks using plain props without constructing Svelte stores.
- Browser tests verify create/receive, approval, cancellation, disabled state, and embedded/configured variants.
- Run Svelte check, client tests, lint, and focused pairing scenarios in both browsers.
