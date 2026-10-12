# Implementation plan: item 39 — Keep completed upload jobs visible

## Goal and retention decision

Show each completed upload row at 100% until **five seconds after that job's completion**, even when the batch contains a queued or failed job. Failures remain available for retry. Follow [the implementation guide](implementation-guide.md).

The current runtime expires only wholly successful batches, five seconds after the last completion. Change that to per-job retention so the TODO's automatic cleanup promise applies to each completed file. Keep manual Clear completed uploads; it must not clear active/failed jobs.

## Code map

- `service/runtime.js::publishUploads()`: batch-based timer; `completedAt`, `completedRetentionMs = 5000`, serialized repository cleanup and disposal.
- `stores/library.js`: `uploadJobs` currently includes **every** status; `uploadCompleted` is an array of IDs, not row objects. `uploading` excludes completed jobs.
- `components/Uploads.svelte`: progress rows render only while `uploading`; failure section already renders failed/interrupted/paused jobs.
- `tests/library.test.js`: first test currently asserts that a completed job stays while its batch has a failure. Its expectation must intentionally change.
- `e2e/uploads.spec.js`: existing shared progress/retention scenario.

## Implementation sequence

1. Schedule the owner timer for the earliest completed job's `completedAt + completedRetentionMs`, independent of its batch. At firing, enqueue cleanup and re-read current jobs; remove only jobs still completed and past their deadline. Clear their persisted job/source entries using the repository, publish, and reschedule the next deadline.
2. Preserve cleanup error handling and avoid a zero-delay retry loop after a failed commit: retry with a bounded delay, keep failed removals visible, and do not falsely claim persisted cleanup succeeded. Disposal/lock/reset cancels timers; a restarted owner uses saved `completedAt`, so elapsed rows expire promptly.
3. Render progress rows whenever eligible rows exist. Either derive `visibleJobs` in Uploads or add a clearly named store projection containing statuses `queued`, `preparing`, `uploading`, `completed`. Do not render failed/interrupted/paused or awaiting context jobs twice; they keep their dedicated retry/popup flows. Keep the full `uploadJobs` projection if other callers rely on it.
4. Keep keyed rows (`job.id`), full name, readable status and progress. Completed is exactly 100%, including when stored `progress` is null. Earlier completion stays visible while later jobs run, until its own deadline.
5. Preserve aggregate uploaded count and manual clear as supplemental controls. The empty message must consider visible rows, failures, history and local submission status. Do not introduce UI timers; all pages consume the owner's shared state.

## Acceptance cases

- One completed job remains visible after `uploading` becomes false, then disappears at its own deadline in both pages.
- A completes, B is held queued/uploading: A expires without waiting for B; B keeps its state and progress.
- A completes, B fails: A expires; B's original source/retry control remains.
- A then B complete at different times: only the due row disappears at each deadline; neither becomes a summary immediately.
- Manual clear removes only completed rows; late progress cannot recreate them. Context uploads still have separate IDs and retry behavior.
- Cleanup commit failure, owner disposal/restart and vault reset do not leak timers, remove failed jobs or corrupt persisted state.

## Verification

Use short `completedRetentionMs` in `library.test.js` and deferred uploads to assert deadlines, two-client projection and retained failed sources. Replace the existing whole-success-batch expectation explicitly. Browser tests retain the real five-second setting, use bounded polling, and assert actual rows/progress after the final upload. Include manual clearing; avoid fixed long sleeps where a deferred upload or deadline comparison is possible.

Run focused library tests, client checks and Firefox/Chromium upload E2E. Inspect long names and mixed active/completed/failed rows at 320/360 px in Firefox light/dark screenshots.

## Implementation notes

Record the deliberate change from batch to per-job retention and timing/error-path results.
