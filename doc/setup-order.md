# Setup order

Change specification for audit finding C2 ([audit](audit-2026-10-22.md)).
Frontend only (`views/Setup.svelte`).

## Goal

Creating a library asked for the invitation code only after preparing keys and
saving the backup, and nothing confirmed that the backup password was stored.
Users should give everything they already have first, then complete one
"save your backup" step.

## Behavior

1. **Create**: the server disclosure, an "Invitation code" field and a "Continue"
   button (formerly "Prepare library") on one form. Continue requires a
   non-blank code and calls the existing `prepareCreation`.
2. **Save your library backup**: the existing backup controls, then a checkbox
   "I stored the backup file and its password", then "Create library". The button
   stays disabled until the backup is downloaded and the checkbox is checked.
   The invitation field stays visible here, pre-filled from step 1, so a rejected
   or missing code (for example after a reload) can be corrected.
3. Discard keeps its current behavior.

The store keeps owning the rule that registration requires a downloaded backup;
the checkbox is local presentation state.

## Exclusions

No session-store, protocol, or backup-format changes. Master-password ordering
and the restore and pair flows are unchanged.

## Acceptance

`make -C client test` and `make client` pass without warnings. E2E create-library
helpers check the confirmation box. Visual review is pending explicit approval.
