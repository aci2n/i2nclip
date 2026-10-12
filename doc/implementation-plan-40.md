# Implementation plan: item 40 — Reconcile tags without reloading results

## Goal

After a successful tag edit, update every open library view from shared service state without issuing another list/search request.

## Changes

- Remove `refreshViews()` from the successful `media.retag` path in the service runtime.
- After a successful retag, broadcast the updated media metadata as today and reconcile each in-memory view's membership against its query tags: add matching items and remove items that no longer match.
- Preserve current result order, pagination cursor, loading state, and drafts. A conflict must still update the item's current metadata and show the existing retry message without treating the user's unsaved tags as committed.
- Do not alter deletion behavior or the explicit search action.

## Acceptance

- Unit/browser regressions assert retagging causes no list request and immediately updates matching/nonmatching views across clients.
- Cover empty query, multiple required tags, pagination, concurrent search response, and metadata conflict.
- Run service/library tests, client checks, and focused two-page browser scenarios.
