# Implementation plan: item 37 — Move Forget Library beside Reset

## Goal and scope

Place “Forget this library” at the bottom of Settings, immediately before Reset Browser, with warning text color. Keep the existing confirmation and owner forget command. Follow [the implementation guide](implementation-guide.md).

## Code map

- `components/ManageLibraries.svelte`: Forget currently shares Rename's action row and local `run()` error handler.
- `stores/application.js::forgetLibrary()`: confirmation and `libraries.forget` command; owner handles selection/catalog updates.
- `views/Settings.svelte`: Vault Settings then `#reset-settings` are currently the bottom controls.
- `App.svelte`: supplies Settings props and the ManageLibraries snippet.

## Implementation sequence

1. Remove only Forget's button from ManageLibraries; preserve Rename and recovery controls. Pass an `onForget` callback from `App` to `Settings`, or a narrow management action prop; avoid subscribing Settings to the whole application merely to move this button.
2. Render a small section/control after VaultSettings and directly before `#reset-settings`. Show it only for a configured selected library. Keep Reset last among settings actions; an action-specific error may be beside Forget rather than appended after Reset.
3. Use the existing `secondary danger` control treatment (`var(--error)` text). Do not invent a new destructive-action theme or move other settings disclosures. Give the control an explicit accessible name and optional stable unique ID such as `forget-library`.
4. Own running/error state in the application workflow/store, or reuse a narrow action facade that the view invokes. Disable while forgetting or session busy; guard double clicks. Capture the selected library ID before awaiting so a later selection cannot retarget the command. The current callback confirms synchronously, but subsequent async work still needs the captured ID/context.
5. Preserve the confirmation text exactly: “Forget this library and its unfinished uploads? Server files stay saved. Keep a recovery file first.” Cancel performs no mutation. Surface command failure beside this action and keep the saved library selected; do not use Rename's former error slot.
6. Successful forget lets the existing owner/catalog selection workflow choose another saved library or first-library setup. Do not add a second confirmation, server delete, or vault reset. Item 36 may have replaced persisted placeholders; use its current empty-catalog behavior.

## Acceptance and verification

- Configured Settings DOM order is VaultSettings, Forget section/control, Reset; first-library setup has no Forget.
- Confirmation cancellation preserves ID/catalog/uploads; success removes only the captured library and leaves server media and other libraries intact.
- Failed owner removal shows a local error and leaves the action retryable. Busy/rapid double click cannot issue overlapping forget commands.
- Verify computed warning text color in both themes, legible confirmation/status, and no horizontal overflow at 320/360 px.

Extend existing `e2e/settings.spec.js`/`multi-library.spec.js` rather than introducing a separate layout suite. Existing catalog failure tests cover owner rollback; add an application test only if the action facade changes. Run client checks/extension build and focused browser cases from the guide; inspect Firefox screenshots.

## Implementation notes

Implemented `createForgetLibrary` as an application-owned action facade with captured library/context, double-submit guard and action-local errors. Settings receives only its state and callback; `#forget-library` follows VaultSettings and precedes Reset. Confirmation wording is preserved. Added cancellation/captured-ID/stale-error coverage. Combined verification is deferred until TODOs 37–46 are implemented, as requested.

Combined checks completed: client tests/checker/lint, web/extension builds and all 64 browser scenarios are covered in [the verification report](verification-37-46.md). Actual narrow Firefox screenshots were inspected.
