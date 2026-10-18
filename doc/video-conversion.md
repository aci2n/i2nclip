# Video upload conversion

## Goal and scope

Extend upload defaults and per-file review with local Mediabunny video conversion.
Output choices are MP4 (H.264/H.265/AV1) and WebM (VP8/VP9/AV1). Exclude standalone
audio conversion, playlists/network input, codec polyfills, advanced editing,
server/database changes and encryption changes. Use browser codecs only, checked
at upload time. E2E execution and visual review remain deferred until requested.

## Interfaces and ownership

Add a required typed video record to UploadOptions: enabled, format, codec,
quality preset, maxWidth, maxHeight, maxFrameRate. Defaults: disabled, MP4/H.264,
medium quality, no bounds/cap. Quality supports very-low/low/medium/high/very-high.
Dimensions are optional positive safe integers; frame rate is optional positive
finite Hz. Container changes select H.264 for MP4 and VP9 for WebM. Validate static
container/codec combinations without browser probes in the UI.

Use a new preference key, resetting both image and video defaults with no legacy
migration (explicit user choice). Copies include independent video records.
Settings owns default editing; review edits remain per file. Present options for
video MIME files or common video extensions with absent/generic MIME. Verify
actual content only during upload. Components remain presentation-only with
ordinary props/callbacks, no stores/workflows or HTML IDs.

Upload preparation gains a conversion-progress callback; store progress gains
preparing/converting/uploading phases. The workspace remains owner of batches,
cancellation and resources; sequential work and navigation survival stay intact.
Extension uploads use defaults without review as before.

## Conversion and lifecycle

Lazy-load the Mediabunny converter only for enabled video conversion. Check input
size before reading media. Read a local Blob; force selected video encoding and
quality. Fit displayed dimensions within bounds with aspect ratio preserved, no
upscaling, and dimensions rounded down for codec alignment. Preserve orientation.
Apply frame-rate cap only below measured source average; applied caps produce
constant-rate output. Preserve timing otherwise. Retain all video/audio tracks:
copy compatible audio or let Mediabunny choose a supported audio encoding. Never
silently discard tracks. Reject invalid conversions, missing video or discarded
tracks, use original and show a per-file notice. Native default opaque video
encoding is used; alpha editing/preservation controls are excluded.

Use finalized nonempty output only when strictly smaller than original. Monitor
output writes and cancel when size reaches original size. Update filename, MIME,
thumbnail and metadata from accepted output. Unsupported/failed conversion uses
original with a notice; cancellation never falls back. Session abort interrupts
initialization/encoding, disposes input/output and cancels active conversion.
Always remove callbacks/listeners and ignore stale progress/results.

## Acceptance checks

Test defaults/reset/persistence/validation, copied snapshots and reset, container
choices, disabled bypass, native capability failures, missing/discarded tracks,
audio retention, valid output and original fallback. Test bounds/alignment,
portrait/rotation, frame caps, phase progress, cancellation during initialization
and execution, resource cleanup and size cutoff. Use isolated converter doubles
for browser encoder behavior and real local media parsing for package integration.
Update browser test definitions for conversion/fallback, mixed batches,
navigation, both themes and narrow layouts; do not execute them yet. Run make
test, client static checks and make test-build. Preserve unrelated working files.
