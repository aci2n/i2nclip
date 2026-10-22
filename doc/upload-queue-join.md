# Add files to a running upload

Audit item C6.

## Goal

Upload, drop, paste and extension captures are refused while a batch runs, so a
user must wait for a long upload before choosing more files. Let new files join
the running batch's queue instead. Batches stay sequential and in memory.

## Behavior

- `uploads.upload(files, extra)` appends its files, each with its own `extra`
  metadata, to the current queue when a batch is running; otherwise it starts a
  batch. The progress total grows as files join.
- Each call's promise resolves when the batch it joined ends: `true` when all of
  that call's files uploaded and the batch completed, `false` otherwise.
  Failures still do not stop the batch and still retain only messages.
- The Library Upload buttons, file drop/paste and the extension receiver no
  longer refuse while uploading. They still refuse in historical views, while the
  session is busy, and when the library is read-only.
- Ending a batch detaches its callers before settling quota, so a selection made
  then starts a new batch. Disposal, identity changes and historical selection
  abort the batch and resolve every pending call with `false`.

## Exclusions

No per-file cancellation, reordering, persistence or limit on queue length
beyond the existing per-file checks.

## Acceptance checks

- Files added during a batch upload in order, each call reports its own result,
  and the displayed total includes joined files.
- An extension capture received during an upload is accepted and uploaded.
- E2E (pending approval): a second drop during an upload joins the batch.
- `make -C client test`.
