# Review cleanup specification

## Goal, scope and exclusions

Apply the six simplifications identified in the review against origin/master,
in order and as separate verified commits: shared removable chips, search
preparation, decoded server labels, explicit frame fixtures, MIME extensions,
and redundant input styles. No dependencies, schema/wire changes, backfill,
deployment, persistent state, or broad test redesign are included.

## Interfaces and ownership

TagChip accepts text, removal label, disabled state and a removal callback; it
owns markup and responsive presentation only. SearchForm and TagEditor retain
their list layout, disclosure, draft and focus behavior. Use 1rem removal icons,
1.5rem desktop removal buttons and 3rem touch buttons in both contexts.
The library store owns strict search preparation, normalized deduplication,
first-spelling preservation and the 64-tag limit. Commas remain invalid.

Parsed Rust tags retain validated label bytes; wire deserialization and catalog
base64 encoding remain boundary concerns. Reference frame encoders accept explicit
serialized tag bytes; fixture label generation and boundary padding are explicit
at their test callers. Share the existing download MIME extension table with tag
generation, retaining the latter's extra mappings and each caller's fallbacks.
Shared input typography stays in app.css; component-specific sizing stays local.

## Lifecycle and failures

No persistence or resource ownership changes. Keep root-owned work, session
invalidation, aborts, stale-result rejection, pagination and atomic writes.
Search admission and validation happen before clearing a submitted draft; rejected
input keeps the draft. Request failures retain existing reporting. Tag-save
failures keep drafts and restore focus. Components gain no asynchronous workflow.
Server limits, duplicate handling and invalid-label rejection remain unchanged.

## Acceptance and sequence

Each step must build without warnings and pass its relevant checks before commit.
Exercise chip removal, long labels, desktop and 320/360px layouts in both themes;
inspect Firefox screenshots. Cover invalid search drafts, normalized duplicates,
64/65 tags, pagination, decoded label validation, atomic replacement and explicit
maximum frames. Preserve cross-language vectors and existing download behavior.
Use Makefile Rust formatting, then run make test-all after the six cleanups.
Tests retain isolated databases, listeners, contexts and resource cleanup.

## Verification completed

All six cleanups were committed separately after focused checks and warning-free
builds. Final `make test-all` passed: client tests/checker, Clippy, formatting,
web/extension build checks, PostgreSQL tests and 62 Firefox/Chromium cases,
including the subsequent Backspace feature. Inspected Firefox screenshots of
desktop and 320/360px chips, wrapped long labels, mixed media, filename editing
and previews in light/dark themes.
