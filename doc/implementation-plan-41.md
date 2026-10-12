# Implementation plan: item 41 — Prepend newly uploaded files

## Goal

Insert each newly uploaded file at the beginning of every open view whose current query matches its tags.

## Changes

- Change `publishUpload` and view reconciliation so a newly uploaded matching ID is placed before the existing IDs.
- Keep a per-view additions collection, but give new additions precedence when a search started before or during the upload settles. Deduplicate IDs and exclude deleted items.
- Preserve server result ordering for existing entries, pagination cursors, and query matching. Do not refresh the list after upload.

## Acceptance

- Test upload insertion at the head for an empty and non-empty search, multiple uploads completing in sequence, and a completed search response racing with upload publication.
- Verify pagination does not duplicate or reorder existing entries, and nonmatching uploads do not appear.
- Run library/service tests and focused two-client browser scenarios.
