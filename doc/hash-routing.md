# Native hash navigation

## Goal, scope and exclusions

Use #/library, #/settings and #/media/<id> with native anchors and a routing store
that observes hashchange. Remove navigation callback plumbing and query routing.
No compatibility handling, delegated click interception, History API patching,
server changes, new persistence/dependencies, or visual changes.

## Interfaces and ownership

lib/routes.ts defines an ordered route table and derives Route and ResolvedRoute
from its typed definitions. The pure parseRoute/routeHref helpers use hashes.
Resolved routes include workspace requirements; navigation inputs do not require
that metadata. See [Typed route definitions](typed-route-table.md). Empty/unknown hashes select Library; missing/malformed media IDs
remain media routes so the existing invalid-link error prevents requests.
The root-owned routing store reads the initial hash, owns its hashchange listener,
and exposes navigate(route, replace) for application workflows. Components import
only pure route helpers and store types, never routing state or methods.
Remove navigation click handlers and onlibrary/onsettings props from views and
components. Ordinary anchors retain native keyboard, modifiers and new-tab behavior.

## Persistence and lifecycle

Native links change the hash; the store reads current location on hashchange.
Programmatic navigation assigns location.hash, or uses replaceState for replacement,
and synchronously publishes the resulting location for extension handoff.
Suppress equivalent route publications and additional history for programmatic
navigation to the current route. Read location rather than event URLs so queued
events cannot restore stale routes. Disposal removes the listener and disables
navigation. No new storage. Root workspace, session and viewer lifetimes remain
unchanged, including upload survival and fresh media tabs avoiding browsing reads.

## Failures and cancellation

Invalid media links retain local errors; unlock/restore retains valid targets.
Back/Forward follows native hash history. Existing stores retain cancellation,
resource disposal, upload failures and extension rejection. Accepted drops and
captures replace the current entry with Library; pending extension captures must
still have uploads available synchronously after unlock.

## Acceptance checks

Unit tests cover hash parsing/formatting, malformed targets, initial state,
hashchange, synchronous push/replacement, current-route no-ops, duplicate/queued
events and disposal. Firefox/Chromium tests cover native mouse/keyboard links,
Back/Forward, reload, new tabs and modified clicks, media targets through unlock/
restore, no browsing requests on fresh media tabs, upload survival, file drops,
and extension handoff. Update route-specific fixtures and URL assertions. Run
client tests/checks and build without warnings; keep browser contexts and test
resources isolated and cleaned up on failure.
