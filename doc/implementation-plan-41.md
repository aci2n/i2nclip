# Implementation plan: item 41 — Prepend newly uploaded files

## Goal and ordering decisions

Insert a newly completed matching upload at the head of every open view on that library, without a list refresh. If uploads complete A then B, display **B, A, existing server order**. Follow [the implementation guide](implementation-guide.md) and retain item 40's normalized query matching and membership overrides.

This is owner-side view ordering, not a DOM sort. Unrelated libraries and nonmatching views are unaffected. Existing IDs keep their relative order and media-card resource owners.

## Code map

- `service/runtime.js::publishUpload()`: currently adds to `view.additions` and pushes onto `view.ids`.
- `search()`: currently merges pagination/current IDs, server page then additions; simply changing `push` is lost when a delayed page settles.
- `tests/library.test.js`: test “uploads append matching cards without list refresh and survive older search results” currently expects `[old, new]`, then `[old, new, old2]`.
- `stores/library.js`: keyed card objects already support moving an ID without recreation.

## Implementation sequence

1. In `publishUpload()` use the query-match helper from 40 and the committed upload result. Add the ID to the front by constructing `[id, ...view.ids.filter(other => other !== id)]`, retaining unaffected order.
2. Add a per-view `uploadHeads` ordered array, newest completion first. On publication use `[id, ...uploadHeads.filter(other => other !== id)]`. Keep ordinary successful-retag additions in the existing `additions` Set; upload completion must not put an ID in both collections unnecessarily. Do not rely on lexical ID order, `createdAt`, submission time or server page order for the new heads.
3. Merge pending-search results as `matching ordered upload additions`, then prior pagination IDs (when more), then server page IDs, then other successful retag additions. Deduplicate by first occurrence and apply 40's explicit membership exclusions. Filter upload heads with the same current-query predicate and membership overrides before merging, so a later retag can remove a promoted item without resurrecting it.
4. Preserve server order/cursor for existing IDs. A delayed initial response with the upload ID already in it includes that ID once at the head; a later page with that ID also cannot duplicate or move it back. Do not increment search revision or abort its request merely because an upload completed.
5. Initialize `uploadHeads` on view creation, reset it with query-specific additions on a fresh explicit search, and clear it on view/context disposal; retain both collections through `more`. An upload completed while the previous query was active must not leak into a new nonmatching query. A completion after query switch evaluates the new submitted query. Exclude deleted IDs from local additions; keep existing deleted-card semantics from 40.
6. Publish entity metadata before the updated view IDs; retain loading/status/next while a search is pending. Newly inserted rows make an empty settled view nonempty immediately. Preserve context-upload and retry publication paths, which also call `publishUpload`.

## Acceptance and verification

- Empty/nonempty unfiltered views and matching multi-tag views get the new ID first; nonmatches get none.
- Completion A then B produces `[B, A, old1, old2]` in two clients regardless of submit order.
- Old initial response, old pagination response and response already containing A/B preserve the head and include each ID once.
- `next` remains server-provided; more appends untouched server rows without changing existing order.
- Switching queries before/after completion, retagging an uploaded item out of the filter, deletion and context invalidation do not leak/resurrect IDs.
- Existing cards keep their object identity, object URLs and editor state. Count list calls: uploads cause zero additional list requests.

Update the append-order unit expectations deliberately; retain their card-identity/cursor/list-count assertions. Add deferred response and multiple completion cases to `library.test.js`. Extend two-page `e2e/library.spec.js` or `uploads.spec.js` using distinct named files and scoped card-title assertions. Run client checks and focused Firefox/Chromium scenarios; inspect a mixed-media narrow library screenshot if card/layout styles changed.

## Implementation notes

Implemented newest-first `uploadHeads` per view, distinct from ordinary retag additions. Merge precedence is heads, prior pagination IDs, server IDs, then retag additions; overrides and normalized current-query matching prevent excluded/deleted promotion. Explicit searches/context resets clear heads; pagination preserves them. Updated existing order/card/cursor tests and two-page browser upload assertions. Combined verification deferred until the end of TODOs 37–46.
