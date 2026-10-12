# Implementing a TODO plan

Read `AGENTS.md`, this guide, the selected item, and the named source/test files. Implement one item at a time in `todo.md` priority order. Completed items are background, not work to repeat.

## Before editing

- Run `git status --short`. Preserve other agents' changes; do not reset, reformat, or commit their files. Source paths below are starting points verified on 2026-10-12, not frozen line numbers. Re-read the relevant functions before changing them.
- Check earlier completed items for changes to the same interfaces. In particular, 36 changes setup ownership, 38 removes saved-server UI, 40 establishes view reconciliation used by 41, and 44 establishes IDs used by 45.
- If a named function moved, find its current equivalent with `rg`. If the implementation contradicts a required outcome, record the discrepancy in the item's implementation notes and resolve it before making a broad change.
- Make a short checklist from the implementation steps and acceptance cases. Do not read every audit or every other plan unless a dependency requires it.

## Ownership and scope

The service engine/repository owns secrets, persistence and async workflows. Stores adapt service state and own page workflows. Components render state and invoke actions. A plan proposing new commands must update `service/contract.js`, routing, client projections, callers and test adapters together. Do not expose private keys in replies, snapshots or logs.

Maintain operation cancellation and stale-result guards across every new await. Preserve the vault/session Web Lock, sequential uploads, one mutation per media item, and the existing encryption protocol. Do not change Rust/API contracts merely to simplify a client feature.

Each plan states behavioral decisions and an implementation sequence. Keep the patch within that scope; do not fold other TODOs into it. Public DOM selectors may remain stable when useful, but must be unique within a document.

## Verification without repeating every suite

Use Node from `client/.nvmrc` and existing dependencies. Install with `npm ci --prefix client` only when missing or the lockfile changed. All example commands below run from the repository root.

- Run named unit files directly: `node --test client/tests/library.test.js`. The existing helpers in `client/tests/helpers.js` and `service-helpers.js` supply deferred promises, service clients and memory repositories. Extend existing suites before adding a framework.
- Client code changes: run `make test-client`, `npm run lint --prefix client`, and `make extension` once after focused checks pass. `make test-client` includes the Svelte checker. If only documentation changed, inspect the Markdown and diff; no build or browser run is needed.
- For browser changes, with disposable PostgreSQL admin access configured, use `npm run e2e --prefix client -- e2e/settings.spec.js --project=firefox` (replace the spec and project as needed). This script rebuilds the required assets before Playwright. The root `make test-e2e` provisions PostgreSQL but runs the full suite; reserve it for a checkpoint when needed. Browser fixtures create their own databases and real local Rust API. Do not use live credentials or `test-smoke` for these items.
- Use Playwright request counters and deferred responses for races; arbitrary long sleeps are not race coverage. Short retention values are injectable in runtime unit tests. Browser timing checks need bounded polling and tolerance around deadlines.
- For visual changes use the existing `shot()` helper, then open actual Firefox images from `client/e2e/shots/firefox/`. Cover light/dark and 320/360 px, plus the realistic mixed-media fixtures when library layout changes.
- Run Rust/database/package/full suites only when the changed contract or packaging needs them, or at a combined checkpoint. Do not repeatedly run `make test-all` for these client items. Re-run a passed check only after a relevant change or unresolved failure.

## Handoff and completion

Record changed interfaces, decisions, commands actually run, results, screenshots inspected and remaining limitations under `## Implementation notes` in the item plan. Mark the TODO complete only after its acceptance cases and required checks pass. If blocked by environment access, say exactly which verification remains; do not claim it passed.
