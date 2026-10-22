> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# Automatic tags and private autocomplete

## Goal and scope

Make uploads searchable without manual tagging. Generate at most 40 ordinary tags
from stored category, format and filename words; allow 64 total tags per file.
Keep the first six card tags visible and disclose the rest. Tags are generated
once, after compression/type detection; subsequent edits never regenerate them.
No backfill, source-page-title tags, AI, persistent catalog cache or legacy frames.

## Interfaces and ownership

Keep HMAC tokens for matching and add encrypted display labels, bound to their
token by purpose-specific AAD. New upload/update frames carry a bounded MessagePack array
of token/label pairs (binary tokens and labels, 96 KiB, 64 entries). The consolidated
baseline defines label BYTEA NOT NULL without a default; all tags require sealed
nonempty labels.
Signed GET /api/tags returns distinct owner-scoped token/label pairs without file
metadata/content. Label writes remain atomic with metadata and conflict checks.

A root-owned catalog store decrypts and verifies labels and owns requests,
cancellation, stale-result rejection and memory. It survives navigation and clears
on session changes/disposal. Refresh after mutations. Components receive ordinary
props/callbacks only, and contain presentation state, never async workflows.

Search stores selected tag arrays; Enter/selection adds a chip and immediately
searches, removal searches, and a rightmost X clears draft/chips. Typing only
filters local suggestions (normalized substring, first 10 alphabetically, exclude
selected). Multiword tags are single chips. No comma-separated search syntax.
Use a reusable labeled input with keyboard-accessible suggestion buttons, without
HTML IDs. Selection saves immediately in the tag editor; failed drafts survive.

## Lifecycle and failures

Existing upload batching/cancellation and metadata conflicts remain intact.
Catalog refresh supersedes pending work; lock/server/identity changes abort and
clear suggestions. Skip corrupt individual entries and show a warning. Request
failures retain the same-session catalog and offer retry without blocking work.
Search retains cancellation and pagination tied to the submitted tags. Generation
splits NFC/lowercased filename words at punctuation/space/underscore, skips words
longer than 64 characters, deduplicates and caps at 40. MIME format precedes
extension, jpeg normalizes to jpg, and category uses existing text classification.

## Commits and acceptance

1. Automatic tags, 64-tag limits and six-tag disclosure.
2. Encrypted labels, SQLx migration, authenticated catalog and root store.
3. Shared autocomplete input and immediate chip search.
4. Tag-editor autocomplete with immediate selection save.

Test generation/limits, Rust/JS frames and vectors, owner isolation, migration
preservation, conflicts/cascades, corrupted catalog entries, abort/stale lifecycle,
chip filtering/pagination and editor focus/failure behavior. Run relevant unit,
database and Firefox/Chromium tests, warning-free builds and inspect Firefox
screenshots at 320/360px in both themes with realistic files and many tags.
Deploy server and client together. Keep applied migrations unchanged.
