# Implementation plan: item 39 — Keep completed upload jobs visible

## Goal

Show each completed upload job, with its completed progress, until the service's automatic cleanup removes it after five seconds.

## Changes

- Keep the service's existing five-second completed-job retention and manual “Clear completed uploads” action.
- In `Uploads.svelte`, render the per-job list whenever active jobs or completed jobs exist, not only while an upload is active.
- Render each completed job at 100% with a completed status and retain it alongside any active jobs. Keep the aggregate uploaded count and manual clear action as supplemental controls.
- Keep failures in their current retryable section and avoid changing retained-source behavior.

## Acceptance

- Extend the shared-client timing test and both-browser E2E test to assert all completed rows remain visible until the five-second deadline, then disappear automatically.
- Cover mixed active/completed batches, manual clearing, and failed uploads not being removed by completed-job cleanup.
- Inspect narrow Firefox light/dark screenshots; run focused client and browser tests.
