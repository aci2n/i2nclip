# Rebased chain mutations

Change specification for audit findings B1 and B2 ([audit](audit-2026-10-22.md)).

## Goal

Uploads and file changes commit even when the library head advanced while they
were prepared, as long as the change still applies to the current verified
state. Unrelated mutations from one tab queue instead of failing.

Today every mutation carries the whole-library checkpoint it was drafted against.
`ChainStore.append` rejects it if any block landed in between, and rejects any
second mutation while one is in flight. A long upload is discarded after all of
its chunks are staged if another tab, device, or a tag edit in the same tab
appends first. A refresh during a mutation also fails.

## Behavior

- `ChainMutation` drops `expected: Checkpoint` and gains an optional
  `check(state: ChainState)` that throws a user-facing error when the draft no
  longer applies. `PreparedFileChange` carries the same optional `check`.
- `ChainStore.append` serializes mutations through one in-memory queue. Each
  attempt synchronizes, runs `check` against the verified live state, signs a
  block whose parent is that state's head, validates it through `reduceBlock`,
  and appends it. If the server answers `409` and the existing exact-hash
  reconciliation does not find the record, the attempt repeats, at most three
  times in total. Other failures are not retried.
- `ChainStore.sync` waits for queued mutations before synchronizing, so a refresh
  never races the local append of its own record.
- Per-operation preconditions:
  - `AddFile`: none beyond protocol validation (fresh random ID).
  - `DeleteFile`: the file exists, is not purged and is not deleted.
  - `RestoreFile` and `PurgeFile`: the file exists, is not purged and is deleted.
  - `ReplaceMetadata`: the file exists, is neither deleted nor purged, and its
    current metadata reference hash equals the one the draft was based on.
- A library card's `revision` is the hex hash of its current metadata reference,
  so a metadata draft is stale only when that file's metadata changed, not when
  any other block lands.
- `FileUpload` drops `expected`; `Uploads` no longer captures a checkpoint before
  preparation. Uploads still require the live (non-historical) view to start.
- `ChainView.mutating` and the `mutating` rejection are removed (no consumers).

## Ownership

`ChainStore` owns the queue, retry and reconciliation. `Files` builds the
metadata precondition; `Library` builds the lifecycle preconditions for
delete/restore/purge. `reduceBlock` remains the protocol authority.

## Exclusions

No wire, protocol, storage or server change. No merge of concurrent metadata
edits; a stale metadata draft is still rejected and kept for retry. The library
store keeps its local one-mutation-at-a-time busy state. No cross-tab
coordination.

## Failure and cancellation

Aborting a queued mutation rejects it without blocking later ones. Disposal
aborts every queued and running mutation. A failed precondition does not append
and leaves staged upload objects to server staging expiry, as before.

## Acceptance

Client unit tests cover:
- a head advanced by another writer before commit still accepts an `AddFile`;
- a server `409` caused by a concurrent append is retried and succeeds;
- two mutations started together both commit in order, and `sync` started during
  a mutation resolves after it without storage errors;
- a metadata edit whose file metadata changed is rejected, while an unrelated
  block does not invalidate it;
- delete/restore/purge reject when the lifecycle no longer allows them;
- an upload completes when another block lands during it.

`make -C client test` and `make client` pass without warnings.
