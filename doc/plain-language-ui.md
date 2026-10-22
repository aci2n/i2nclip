# Plain-language library and settings UI

Change specification for audit findings C1, C3, C4 and C5
([audit](audit-2026-10-22.md)). Frontend only.

## Goal

Ordinary users should not meet chain vocabulary ("block", "trusted head",
"rollback protection", "retained", "staged") in everyday screens, and every
empty or status state should offer the next action beside it.

## Changes

- **History (C1).** `HistorySelector` becomes a collapsed disclosure labelled
  "Earlier versions". It opens automatically while a historical version is
  selected, and its summary then reads "Viewing version N (read-only)". The input
  is labelled "Version"; the buttons read "Show version" and "Back to current".
  Status text: "Current version N." or "Viewing version N. Uploads and changes
  are disabled; permanently deleted files stay unavailable."
- **No matches (C3).** The no-match empty state gets a "Clear search" button that
  submits an empty query, as AGENTS.md requires.
- **Copy (C4).** Settings usage: heading "Storage", lines "Storage: X of Y",
  "Files: N of M", "Change history: X", and the note "Includes deleted files
  until you delete them permanently." The library summary states that access
  cannot be revoked. Forget/Reset copy explains the effect without internal
  terms.
- **Status placement (C5).** Settings sections other than "Your library" are
  already disclosures. The backup-password copy notice moves inside the backup
  disclosure beside its button; the password-change status is already shown by
  `PasswordSettings`, so the separate notice paragraph is removed.

## Exclusions

No store, protocol or layout-system change; no new components. Setup flow
restructuring (C2) is a separate specification.

## Acceptance

`make -C client test` and `make client` pass without warnings. E2E selectors that
named the old strings are updated. Firefox screenshots at 320/360 px and both
themes remain pending explicit approval.
