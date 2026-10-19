# Native thumbnails for large videos

## Goal and scope

Attempt a first-frame thumbnail for browser-decodable video files of any supported
upload size, without reading the complete file into a JavaScript byte array.
Keep the existing 320-pixel WebP thumbnail, original media dimensions and unchanged
video upload bytes. This supersedes the blanket thumbnail cutoff in chunk-uploads.

Exclusions: transcoding, additional frame selection or black-frame detection,
custom container parsing in production, new dependencies, strict native-decoder
memory guarantees, background thumbnail generation, and changes to encryption,
server APIs, schemas, quotas or upload sequencing.

## Interfaces, ownership and lifecycle

Change the internal helper to thumbnail(blob, signal). It receives the original
Blob/File, selects its preparation path and owns temporary decode resources.
Video uses a temporary Blob URL and the native video element at every file size;
the browser may seek elsewhere in the complete file for container metadata.
Images retain the 32 MiB decode cutoff. Only bounded audio-art extraction reads the input through
Blob.arrayBuffer(); other file types do not acquire a full JavaScript input buffer.
The upload workflow calls the helper directly and still checks cancellation before
publishing its result or sending an upload. Stores retain workflow ownership.

Keep the eight-second video deadline and best-effort behavior: unsupported files,
decoding/encoding errors and timeouts yield no thumbnail and upload the original.
Cancellation releases the video source, object URL, timer and event listeners;
late decode/encode callbacks cannot publish results or restart preparation.
No preparation state is persisted. Successful thumbnails remain encrypted in the
existing metadata and survive reloads. Large-video notices must no longer say
thumbnail generation was skipped. Large non-video preparation notices remain.

## Acceptance checks

- Unit tests reject any whole-file video read, verify successful thumbnail size
  and original dimensions, and cover timeout, error, cancellation and late events.
- Image and audio inputs above 32 MiB are skipped before decoding/reading;
  small audio artwork and ordinary image thumbnail behavior remain intact.
- Real Firefox/Chromium tests upload large valid WebM and MP4 files, including an
  MP4 index beyond the first 32 MiB, and verify saved thumbnails after reload.
  Generate isolated padded fixtures from checked-in video clips; do not add large
  binaries, runtime API shims or machine-specific tools.
- Run client tests/checks and web/extension build checks, plus focused browser
  preparation/playback cases. Inspect Firefox screenshots in both themes and at
  320/360-pixel widths. Report native decoding as browser-managed rather than
  claiming a strict browser memory bound.

## Verification

Client unit tests, Biome/TypeScript/Svelte checks, and web/extension build artifact
checks passed. All 14 focused browser cases passed across Firefox and Chromium:
large MP4/WebM thumbnails persisted after reload, existing image preparation still
worked, and native playback including tail-indexed MP4 seeking remained intact.
The large fixtures each exceed 64 MiB; the MP4 index follows a 64 MiB free box.
Unit coverage also uses a simulated file larger than 1 GiB and forbids whole-file
video reads, plus cancellation, timeout, decode/encode errors and late callbacks.
Inspected Firefox screenshots at 1100, 320 and 360 pixels in both themes. These
checks establish application behavior; native browser buffering remains outside
a strict application memory bound.
