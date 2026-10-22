# History timeline and undo

## Goal

Replace the Library page's version-number selector with a dedicated History tab:
a newest-first timeline where each block shows its action, file and time, with
View (read-only Library at that version) and Undo (append the inverse operation).
Blocks carry an encrypted client timestamp.

## Protocol

Block plaintext becomes `[unix_ms, operation]`, where `unix_ms` is a safe
non-negative integer from the signing client's clock and `operation` is the
positional file operation array. The time is signed and encrypted with the
operation, so the server learns nothing new. It is display-only: there is no
ordering or monotonicity requirement, because device clocks differ. Existing
libraries are not readable after this change (greenfield format, no fallback).
Rust treats operation plaintext as opaque, so no server or vector change.

## Undo

The inverse is computed against the current verified live state:

| Block | Inverse | Applies when |
| --- | --- | --- |
| `AddFile` | `DeleteFile` | file is live |
| `DeleteFile` | `RestoreFile` | file is deleted, not purged |
| `RestoreFile` | `DeleteFile` | file is live |
| `ReplaceMetadata` | `ReplaceMetadata` with the superseded document | file is live and its metadata is still this block's |
| `PurgeFile` | none | never |

A metadata undo re-reads the superseded metadata document and seals it again
with a fresh key: the server commits only newly staged blobs. The thumbnail
reference is kept as is. Undo appends an ordinary block, so it can be undone too;
there is no redo stack. Undo is shown only when it applies, and the append
repeats the same precondition after rebasing.

## Interfaces and ownership

- `chain-state.ts`: `encodeBlockPayload`, `decodeBlockPayload` and a pure
  `inverseOperation(entry, state)`.
- `ChainStore`: `ChainMutation.operation` replaces `plaintext`; the store stamps
  the time on each signing attempt. `history(signal)` replays the verified cached
  chain up to the live head and returns one entry per block (sequence, time,
  operation, and the superseded metadata reference for metadata edits).
- `Files.revertMetadata(file, previous, signal)` prepares the metadata inverse.
- A new `History` store is owned by the workspace. It loads entries, resolves
  current file names for the shown entries, pages through them 50 at a time and
  runs one undo at a time.
- A `#/history` route and a History view and Timeline component. Library shows a
  read-only banner with "Back to current" while a past version is selected.
  `HistorySelector` is removed.

## Lifecycle and failures

History state is in memory only. It reloads when the live head changes after the
first load. Loading, name resolution and undo abort on workspace disposal; stale
loads are superseded. A second undo while one runs is rejected. An undo that no
longer applies fails beside its entry without appending. Purged files show as
"Purged file", and unreadable names fall back to a short ID.

## Exclusions

No server, database or wire-header change; no metadata diff display; no purge
undo; no redo stack; no persisted history; no cross-tab coordination.

## Acceptance

- Payload round-trips, rejects noncanonical or invalid times, and replay keeps
  materialized state unchanged apart from the format.
- `inverseOperation` covers each row of the table, including stale metadata and
  purged files.
- `history()` returns times and superseded metadata, and rejects a cache that
  conflicts with the live head.
- Undo for add, delete, restore and edit produces the expected live state;
  overlapping undo is rejected; inapplicable undo appends nothing.
- `make -C client test` and `make client` pass without warnings.
