# Metadata index concurrency

Change specification for audit finding B3 ([audit](audit-2026-10-22.md)).

## Goal

Opening a library reads every file's encrypted metadata object one request at a
time. With the 10,000-file default quota, that's minutes of "Loading metadata…".
The server admits two concurrent downloads per library key, so the client should
use both.

## Behavior

`MaterializedView.runIndex` reads metadata with two workers that share one
queue of files. Progress, per-file error collection, the revision check, and
completion behave as before; only the order in which files finish can differ.
If one worker fails with an abort or a revision change, the other is aborted
too and stops before starting another read.

## Exclusions

No persistent metadata cache (that would add state persistence, which needs its
own decision), no server change, no change to the per-key limits.

## Acceptance

A unit test shows at most two metadata reads in flight, both slots used, every
file indexed, and per-file errors still reported. `make -C client test` passes.
