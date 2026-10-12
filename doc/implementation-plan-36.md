# Implementation plan: item 36 — Ephemeral Add Library setup

## Goal

Keep unfinished Add Library form state in the current client only. Create a vault library entry only after remote registration succeeds; a failed registration produces an error and can be started again from the form.

## Changes

- Replace `createSetup`'s persisted provisional-library workflow with an in-memory form draft. Do not call `libraries.beginSetup` before submission.
- Remove resume setup UI/state and the Cancel Setup action. Remove the discard-pending-creation control and its confirmation path.
- Generate the identity in memory, perform the requested OTC or authorization registration, and only then persist the identity and install/select the library. On failure, clear transient key material and keep a concise actionable error; do not retain an identity or pending registration for retry.
- Remove setup-only catalog/repository commands and setup metadata that are no longer needed. Preserve completed libraries and current recovery formats.
- On upgrade, discard legacy unfinished setup entries and pending-creation identities so they do not reappear as resumable work. Keep already registered identities intact. If cleanup fails, surface a recoverable vault error rather than silently reporting success.
- Ensure navigation or closing the setup drops its unsaved draft; creating a new draft starts clean.

## Acceptance

- Unit tests prove failed OTC and authorized registration leave no persisted identity/library, and successful registration persists exactly one completed identity.
- Verify close/reopen does not restore a draft, reset/server changes do not commit stale work, and older completed libraries remain readable.
- Update settings/catalog and browser regressions to assert the removed controls are absent and failures display beside the submit action. Run client, Rust/API checks if service contracts change, Svelte checks, lint, and focused browser tests.
