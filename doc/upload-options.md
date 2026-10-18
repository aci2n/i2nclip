# Upload options

## Goal and scope

Review web uploads per file before starting, with device-local image conversion
defaults in Settings. JPEG, PNG and BMP inputs may become WebP, JPEG or PNG.
Video conversion is specified in [video conversion](video-conversion.md).
Standalone audio conversion, persistent queues and server/database/protocol
changes are excluded.

## Interfaces and ownership

Typed media-specific options replace the compression boolean in preferences and
upload preparation. Images have enabled, format, quality (0–100), and optional
positive-integer maxWidth/maxHeight. Defaults are enabled, WebP, quality 85, no
bounds. PNG ignores quality; JPEG composites transparency on white. Video options
add container, codec, quality preset, bounds and a frame-rate cap
without changing batch ownership. They default disabled, MP4/H.264, medium quality
and no bounds.

The root preferences store persists defaults under a new device-local key,
independently of identity/recovery/pairing, without migrating earlier checkbox or
image-only preference records.
Invalid saved values use built-in defaults with feedback; failed saves retain the
previous values. Settings saves valid changes beside the controls.

The workspace upload store owns staged files and workflows. Picker, paste and
drop append independent entries (including equal filenames). Each entry copies
current defaults; changes never alter other entries or Settings. Use defaults
explicitly copies current defaults. Presentation components only take values and
callbacks. Views subscribe to the specific stores they need. HTML IDs are forbidden.

## Lifecycle and failures

Pending entries survive navigation, but only in memory. Remove/Cancel releases
pending references. Workspace disposal (identity/server/session change) clears
pending and active state and aborts work. Start upload freezes the entries and
options, clears the pending queue and processes sequentially. Reject staging and
other batches during an active batch. Extension captures continue immediately
with defaults, but are rejected while entries await review. Processed files are
released; failed files must be selected again.

Validate options before accepting edits. Conversion and capability checks happen
only during upload. Check original size before decoding. Preserve aspect ratio,
fit within both bounds, never upscale, and replace only with strictly smaller
output of the requested MIME type. Filename, metadata and thumbnail follow the
chosen output. Unsupported/failed/larger conversion keeps the original with a
per-file notice beside results until dismissal or the next batch. Abort must not
fall back to uploading the original. Close bitmaps on every path and suppress
stale progress/results. Individual file failures do not stop the batch.

## Acceptance

Test persistence/validation/storage failures; independent snapshots/reset,
append/remove/cancel/disposal/overlap; all formats, JPEG white compositing,
quality, single and dual bounds, aspect ratios, no upscaling, fallback notices and
cancellation/resource cleanup. Browser tests must explicitly start reviewed
uploads and cover picker/drop/paste, extension defaults, mixed files and output.
Run make test and make test-build. E2E execution and Firefox screenshot review
are deferred until the user explicitly requests them. Later visual review covers
both themes, desktop and 320/360px widths, realistic images and long names.
