# Implementation plan: item 42 — Hide unavailable Authorize tab

## Goal and eligibility decision

Show Authorize only when the current vault has at least one saved library whose session is configured, unlocked and not busy. Pairing-active/unfinished setup entries are not authorizers. Follow [the implementation guide](implementation-guide.md).

If no eligible authorizer remains, an idle setup in Authorize falls back to OTC (`mode: "create"`). Preserve explicitly selected Pair/Restore modes and an active pairing session. When authorizers remain but the selected ID disappears, use the currently selected saved library if eligible, otherwise the first eligible catalog entry. A started registration keeps its captured authorizer; changes never silently retarget that attempt.

## Code map

- `components/Setup.svelte`: fixed four-tab list, panel, selector currently includes all catalog entries, and `selectTab()` receives a second hardcoded list.
- `stores/settings.js`: chooses default mode/authorizer on session/library changes.
- `stores/setup.js`: independently defaults to Authorize from catalog length.
- `service/scope.js` and setup projection enrich catalog rows with current `session` state.
- `stores/dom.js::selectTab()`: existing roving tab focus helper.
- `service/runtime.js::authorizeKey()` and item 36 owner registration: enforce authority beyond UI.

## Implementation sequence

1. Add one eligibility helper shared by setup/settings defaults and view projection, e.g. in a small existing setup helper module. Derive from actual row session booleans, never from catalog length alone. Missing session state is ineligible; readiness changes should update reactively.
2. Normalize idle mode/selected authorizer in the workflow store when catalog/session state changes. Update only when the selected value is invalid; avoid Svelte effects that repeatedly reset the user's chosen mode/name/server. Item 36 may have unified first/additional setup: use that current adapter instead of resurrecting persisted setup state.
3. Build one visible tab descriptor list: OTC, optional Authorize, Pair, Restore. Use it for rendering, keyboard navigation, roving `tabindex`, `aria-selected` and panel relationships. Remove the Authorize panel from DOM when unavailable, not merely its tab; no orphaned ARIA IDs or hidden interactive authorizer controls.
4. Render only eligible selector entries. Show single-authorizer text when the **eligible** count is one; show a selector otherwise. The owner derives the server from the selected authorizer. Lock/busy transitions during another page's identity mutation remove its eligibility.
5. If a focused Authorize tab is removed, move focus to the fallback visible tab once the DOM updates using the existing DOM adapter. If focus is elsewhere, do not steal it. Arrow keys/Home/End traverse only visible enabled tabs; they cannot focus a missing ID.
6. Revalidate on submit in the store and owner. If the captured authorizer becomes invalid while authorization is in flight, abort/reject via existing context guards; no local commit or switch to a different authorizer. Put the resulting error beside a visible setup action/status so it does not disappear inside a removed panel.

## Acceptance cases and verification

- Empty vault/catalog or all ineligible rows: exactly OTC, Pair, Restore; no Authorize tab/panel/selector.
- One eligible row plus locked/busy rows: Authorize visible, single eligible choice only.
- Multiple eligible rows: selector matches only those IDs; current selection retained while valid.
- Selected authorizer locks/is forgotten/becomes busy: idle default changes correctly; pending operation cannot commit stale work or retarget.
- Pair/Restore stay selected when eligibility changes. Active pairing is not interrupted by an unrelated authorizer transition.
- Roving tab focus, ArrowLeft/Right, Home/End and every ARIA reference work with both three/four-tab configurations; removed focused tab gets a valid focus target.

Add unit coverage for eligibility/default normalization in existing catalog/settings-related tests or a small helper test. Update `e2e/setup.spec.js`'s current four-tab/no-library expectation and keyboard assertions. Exercise first/additional setup and multi-page state changes in Firefox/Chromium. Run client checks/extension build and inspect narrow setup layout if the tab geometry changes.

## Implementation notes

Added shared eligibility/normalization helpers for configured, unlocked, idle, non-pairing authorizers. Idle defaults and selectors use only eligible rows; Pair/Restore are preserved, and in-flight submissions retain their captured authority. Owner revalidates source eligibility at final commit. Setup renders one dynamic tab descriptor list and removes the unavailable panel entirely; a DOM adapter restores focused removed tabs to the visible active tab. Updated empty-vault keyboard/browser expectations and eligibility unit coverage. Combined verification deferred until the end of TODOs 37–46.
