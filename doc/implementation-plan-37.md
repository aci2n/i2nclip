# Implementation plan: item 37 — Move Forget Library beside Reset

## Goal

Place “Forget this library” at the bottom of Settings, immediately before “Reset this browser,” and style it as a warning action.

## Changes

- Remove the action from the Manage Library disclosure in `ManageLibraries.svelte`.
- Expose the existing `app.forgetLibrary` action to the Settings view and render it as its own warning-styled control immediately above the reset disclosure.
- Keep the existing confirmation wording, server-data explanation, and error handling. Keep the action disabled while the session is busy.
- Keep reset last in the page flow.

## Acceptance

- Browser test verifies visual/DOM order, warning styling, confirmation cancellation, and successful forget behavior.
- Check narrow Settings layout and both color themes; run Svelte check and lint.
