# Implementation plan: item 40 — Reconcile tags without reloading results

## Goal and membership decisions

Successful retagging updates shared metadata and current view membership without a list/search request. Preserve existing card objects for IDs that remain visible, pagination cursor, loading state and unsubmitted search text. Follow [the implementation guide](implementation-guide.md).

Membership uses **every** normalized required tag from the submitted `view.query`; an empty query matches every available item. Use `normalizeTag`/`splitTags`, not substring matching or case-sensitive chip text. Only reconcile known changed entities; do not attempt to fetch all missing matches.

For a successful edit, retain the position if already present, remove a nonmatching ID, or append an absent matching ID. Newly uploaded IDs get head precedence in item 41. On a conflict, publish latest server metadata and the retry message but **leave existing memberships unchanged** so a failed inline draft is not disposed. The user can review/retry or explicitly search. This is a deliberate temporary exception to exact query membership after a conflict.

## Code map

- `service/runtime.js::dispatch("media.retag")`: success/conflict metadata handling ends with `mutationRevision++` and `refreshViews()`.
- `search()`: revision/controller/identity guards, stale entity protection and merge with `view.additions`.
- `updateEntity()` awaits tag-token verification before writing/broadcasting; a local edit can finish during that await.
- `stores/library.js`: reuses `cards` by ID, disposes removed cards and preserves draft query separately.
- `stores/media-item.js`, `tag-editor.js`, `components/TagEditor.svelte`: failed inline drafts/focus and downloaded media ownership.
- `tests/library.test.js`: refresh/card-identity test; service and media tests cover conflicts.

## Implementation sequence

1. Add a small shared query-match helper for valid plaintext metadata tags using protocol normalization. Factor the upload predicate through it where convenient, keeping upload insertion order unchanged until 41. Never add deleted or metadata-unavailable items based on an uncommitted draft.
2. On successful metadata PUT, update the existing entity with committed metadata/tokens/hash; remove `refreshViews()` from both success and conflict handling. Broadcast media before publishing membership so added cards have metadata when rendered. Keep existing error/busy updates and per-ID mutation serialization.
3. For each current view apply the membership decisions above, deduplicate IDs and publish changed membership. Preserve `next`, query, revision, status and loading. Update `empty` to null for nonempty IDs, otherwise `search`/`library` once not loading; an in-flight search's loading/empty status remains owned by search.
4. Add a **per-view membership override map** (e.g. `id -> included`) for successful tag changes during the current submitted query. Keep the existing additions collection for absent matching IDs. Remove excluded IDs from additions. Reset overrides on a new explicit search, not pagination; clear them with the view/context. Compute them from each view's own current query, not the editing page's draft.
5. When a started list/more request settles, merge server IDs/current IDs/additions through the overrides: exclude changed nonmatches and retain changed matches even if the response omitted them. A response begun before a mutation cannot replace its latest hash/tags or resurrect a removed member. Preserve server order for untouched IDs and server `next`; never issue an implicit search to repair the race.
6. Strengthen stale guards at the **final entity write**, after asynchronous tag-token validation. Capture entity/mutation version or re-read authoritative entity before publishing; checking only before `await updateEntity()` is insufficient. A superseded view/query cannot write stale metadata or membership into the current context.
7. For a metadata conflict, use only the returned authoritative metadata, preserve the submitted draft in its card editor, show the existing review/retry message and return false. Increment the mutation revision so an older list cannot overwrite the conflict metadata. Do not apply success membership overrides for the rejected draft; do not evict the conflicted card. If metadata cannot be opened, retain the unavailable state and draft.
8. Retain deletion semantics: current deleted cards remain as deleted until explicit search, with their resource owner; no delete-triggered list refresh is introduced. Overrides/additions must not resurrect deleted items in later merges. Do not dispose/recreate unaffected cards merely to update tags.

## Acceptance matrix

| Scenario | Required outcome |
| --- | --- |
| Empty-query edit | Same position and card/resource object; fresh metadata; zero extra GET list |
| Required tag removed | Changed ID removed from matching views; unrelated IDs/order/cursor remain |
| Required tags gained | Known item appended to each matching view; no fetch for unknown items |
| Multiple normalized tags | All required tags must match; equivalent spellings behave consistently |
| Two clients with different queries/drafts | Each submitted query reconciles independently; draft search text unchanged |
| Old initial/more response after edit | Latest metadata and membership survive; pagination deduplicates |
| Mutation during token-verification await | Delayed entity publication cannot overwrite committed metadata |
| Conflict or unavailable conflict metadata | False result, latest known metadata/error, inline draft/card retained, no list |
| Deleted item, reset, view disposal or newer explicit search | Existing deletion/cancellation semantics; no stale insert or publication |

## Verification

Extend `library.test.js` and relevant `media-item.test.js`/`tags.test.js`, with list call counters and deferred initial/more responses. Replace the old metadata-refresh expectation with zero-refresh and card-identity assertions. Use real normalized tags/tokens where validity matters; placeholder metadata-less fixture rows should not be globally filtered away.

Extend `e2e/library.spec.js` with two pages on the same service and different submitted filters. Count `/api/media` list GETs separately from metadata/content requests; retag may issue its PUT but no list GET. Check inline focus/draft behavior and unchanged unaffected DOM cards. Run client checks and focused browser scenarios from the guide.

Update the search/metadata ownership statements in `doc/client-service.md` when implementing; it currently describes first-page refresh after canonical media changes.

## Implementation notes

Implemented normalized all-tag membership reconciliation without list refresh. Each view keeps inclusion/exclusion overrides through pagination and resets them on explicit search. Matching known IDs retain position or append; exclusions remove only the changed card. Conflicts broadcast authoritative metadata/error without membership eviction. Entity writes recheck authority after asynchronous token verification, preventing stale metadata publication. Added regression coverage; combined verification is deferred until the end of TODOs 37–46. Item 41 uses the same matching/override merge.
