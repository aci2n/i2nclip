# Simple image compression and immediate uploads

## Goal, scope and exclusions

Remove video conversion, configurable image formats/quality/resizing, and staged
upload review. Keep a device-local “Compress images to WebP” checkbox, enabled by
default. JPEG/PNG/BMP compress at quality 85 without resizing, retaining the
original on unsupported, failed, or larger output. Videos upload unchanged.
Remove Mediabunny and obsolete controls, APIs, tests and documentation. Preserve
video playback/thumbnails, unrelated Settings/pairing fixes, server, schema and
encryption protocols.

## Interfaces and ownership

Keep image encoding separate from file preparation, transport and upload-store
workflows. Preparation accepts a compression boolean, checks source eligibility
and final size, and returns the selected file. Transport publishes its prepared
name. Remove conversion progress callbacks and media option types. Upload state
has preparing/uploading phases only. Views pass plain props to components; stores
own async work and cancellation. Selection, drop, paste and extension handoff
start immediately, without pending-review state or confirmation.

## Persistence, lifecycle and failures

Restore the boolean i2nclip.compress-images preference, default true, with adjacent
read/write errors; ignore structured media options without migration. Snapshot the
boolean for each batch. Root-owned sequential batches survive navigation, reject
overlap, continue after file failures and retain only failure messages. Consume
owned file references as processed and clear queued references on disposal.
Cancellation propagates through compression, prevents stale names/progress and
releases decoded bitmaps. Eligible oversized images may compress; disabled or
ineligible oversized inputs reject before reads, and selected output must meet
the effective limit before reading upload bytes. Extension handoff shares this
policy. Retain fallback notices, actual output names, and finite/clamped progress.

## Acceptance

Test WebP settings, fallback, cancellation/resource cleanup, boolean persistence,
source/output size enforcement, extension policy, prepared names, late/invalid
progress, immediate selection/drop/paste, batch continuation and session disposal.
Run client unit/static/build checks and real-server Firefox/Chromium browser tests;
inspect Firefox screenshots in both themes at desktop and 320/360 px. Audit source,
tests, docs, manifests, lockfile and rebuilt output for removed features. Preserve
legitimate video playback and thumbnail references.
