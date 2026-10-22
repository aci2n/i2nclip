> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# API and preview simplification

Historical specification. The single-item metadata read is now required by
[private media deeplinks](deeplinks.md); current endpoint contracts are in [protocol](protocol.md).

## Goal and scope

Remove unused standalone metadata reads, returned search tokens, and preview-driven
pagination in three separate commits. Each commit includes its relevant tests and
current documentation. Pairing, extension capture, audio artwork, upload progress,
quotas, database schema, and encryption/request formats are excluded.

## Interfaces and ownership

1. Remove client getMetadata, GET /api/media/{id}/meta, and the dedicated database
   metadata query. Keep PUT on that path; unsupported GET uses the router's 405.
   List entries and metadata-conflict responses continue to supply metadata.
2. Remove tokens from media responses, database result objects, and client media
   state. Remove response-only token aggregation and conflict-time token reads.
   Preserve request-frame tokens, transactional tag storage, and AND tag search.
3. Remove library.morePreview and dialog paging state. Previous/Next and arrow keys
   navigate only loaded, nondeleted, previewable items. Disable them at loaded
   boundaries even when another page exists. Close preview and use More to fetch
   another page of the submitted search; reopening includes newly loaded items.

Views keep selection/navigation presentation and pass ordinary props/callbacks.
Stores retain ownership of requests, cancellation, media resources, and workflows.
No new abstractions, dependencies, persistent state, migrations, or compatibility
handlers are introduced.

## Lifecycle and failures

Root-owned work still survives view navigation. Identity changes, searches, and
session disposal invalidate pending results and dispose owned media resources.
Closing a preview invalidates its pending selection so a delayed download cannot
reopen it. Keep download retry, native-player shutdown, focus restoration, and URL
revocation. Metadata conflicts return the current encrypted metadata and preserve
the caller's draft without overwriting stored metadata or tags. Normal pagination
remains single-request and tied to the submitted query.

## Acceptance checks

Adapt metadata decryption, cancellation, signing, and error tests to list/update;
remove standalone read-only cases and cover unsupported GET. Assert response token
absence and prove tag persistence, replacement, clearing, rollback, and concurrency
through searches or isolated SQL assertions. Preserve search pagination and stale
media resource tests. Browser coverage must show loaded-boundary navigation cannot
fetch pages, More still uses the submitted query, and loaded navigation/playback
works. Inspect Firefox screenshots of preview controls.

Build without warnings before each cohesive commit. Run make test, make lint,
make format-check, make test-db, and make test-e2e after the refactors, with Node
from client/.nvmrc. Tests own isolated databases, listeners, and browser contexts.
