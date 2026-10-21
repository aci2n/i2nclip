# Native streamed download dispatch

## Goal and scope

Fix Chromium cancellation of real library downloads while preserving authenticated,
bounded service-worker streaming and browser-selected download destinations.
Generated native streaming downloads already pass through an ordinary same-origin
link; library downloads additionally set the HTML download attribute. Traces show
cancellation after the browser download event without the normal page request path.

## Interface and ownership

The library store still owns source preparation, cancellation, and stream lifetime.
Dispatch its virtual download URL as ordinary navigation through a temporary anchor.
The worker's attachment Content-Disposition and encoded source filename determine
the saved name. Remove the redundant HTML download attribute. No schema, API,
crypto, persistence, component workflow, buffering fallback, or new dependency.

## Failure and lifecycle

Keep existing cancellation and exact chunk authentication. The stream lease lives
until completion or failure and is disposed in its existing finally block. A
cancelled or superseded session cannot initiate a save. Browser failures remain
local download errors; dispatch must not route away from the application.

## Acceptance

Verify real library and recovery/history downloads on Chromium and Firefox,
including Unicode filenames and empty files. Broaden to streaming and large-file
browser coverage once dispatch is confirmed. Keep existing store lifecycle tests,
client static checks, and a warning-free production build.
