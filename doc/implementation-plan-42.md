# Implementation plan: item 42 — Hide unavailable Authorize tab

## Goal

Show the Authorize setup tab only when at least one saved library is unlocked and eligible to authorize a new registration.

## Changes

- Derive the eligible authorizer list from the current catalog and each library's unlocked state.
- Include the Authorize tab and panel only when that list is non-empty; bind the selector to eligible entries only.
- If the active mode becomes unavailable after a lock or catalog change, select OTC when available; keep Pair and Restore modes intact.
- Ensure keyboard tab navigation and ARIA tab/panel relationships use the same visible-tab list.

## Acceptance

- Cover no saved libraries, all libraries locked, one eligible library, multiple eligible libraries, and an authorizer locking while selected.
- Verify tab keyboard navigation and that authorization remains disabled if the selected authorizer becomes unavailable during submission.
- Run settings unit/browser tests in both browser projects.
