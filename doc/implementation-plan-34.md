# Implementation plan: item 34 — Image compression before upload

## Goal and decisions

Compress static JPEG/PNG images before encryption, enabled by default with one local vault preference to disable it. Use WebP quality **0.82**, retain original dimensions, and replace the source only when valid WebP output is strictly smaller. No resizing, quality slider, new codec dependency or CLI image conversion is part of this item. Follow [the implementation guide](implementation-guide.md).

A conversion is lossy and removes ancillary image metadata. Say so beside the setting. Preserve the displayed orientation and transparent pixels; encoded EXIF fields are not a preservation requirement. GIF, APNG, existing WebP, SVG, AVIF, HEIC and other formats pass through unchanged.

## Code map

- `media/upload.js`: `prepareMedia()` enforces bounded input; `sendUpload()` reads bytes and calls the API.
- `service/runtime.js`: `prepareJob()` prepares previews; both `capture()` and `pump()` call it. `capture()` runs before a context upload is submitted, so it must not lock in the compression preference.
- `media/thumbnail.js`: existing browser bitmap/canvas examples; thumbnails are a separate small WebP with their own quality and dimensions.
- `media/metadata.js`, `api.js`: type sniffing and metadata (`name`, `content_type`, `size`, `image`) must describe the bytes actually encrypted.
- `service/repository.js`: encrypted catalog currently has libraries/jobs, not preferences. `service/engine.js`, `contract.js`, `stores/vault.js`, `components/VaultSettings.svelte`: preference persistence, state and UI.
- `service/source-record.js`: retained upload sources and previews survive owner restart. CLI uploads use their existing path and do not have canvas support.

## Implementation sequence

1. Add a pure, bounded JPEG/PNG identification and PNG chunk-inspection helper plus a browser conversion helper, e.g. `media/image-preparation.js`. Inspect signatures even when `Blob.type` is missing (context-menu images). Do not trust an arbitrary MIME label as proof of image format. Parse PNG chunks by length/type, never by searching arbitrary bytes for `acTL`; malformed/truncated chunks mean skip conversion. Any valid `acTL` means APNG: keep original bytes.
2. Limit conversion to at most **16,777,216 decoded pixels**, preserving the file itself when it exceeds the limit. Read dimensions from bounded JPEG SOF/PNG IHDR parsing before allocating a full canvas; if dimensions cannot be safely established, skip conversion. This limit protects memory, rather than resizing oversized images. Check the bitmap's actual dimensions again after decoding.
3. Decode with `createImageBitmap`, draw at its displayed/oriented dimensions to `OffscreenCanvas` when available, and use a document canvas only in a document host. A worker lacking an encoder must safely keep the source. Reuse the orientation once; do not apply EXIF rotation a second time. Close bitmaps and release canvas storage in `finally`.
4. Request `image/webp` at 0.82. Reject null output, non-WebP MIME/signature, output at least as large as the input, or invalid/oversized output. Preserve the original on ordinary decode/encode/support failures. Check cancellation before decoding, after every await and before returning. **Abort is propagated**, never converted into original-file fallback.
5. Return a new source object only when conversion succeeds: `blob` is the WebP, `contentType` is `image/webp`, and the last filename extension becomes `.webp` (or append it when absent). Remove obsolete original `bytes` and cached `preview` fields on that transient object. Recompute the thumbnail from converted bytes; keep its own quality/size settings unchanged.
6. In the owner upload path capture the preference once when a queued job actually enters `preparing`, after acquiring the upload lane. Convert after `prepareMedia()` and before thumbnail/bytes/encryption. Do not convert in `capture()` or again in `sendUpload()`. Route ordinary uploads and submitted context uploads through this same step; retries are new preparation attempts.
7. **Retain the original source for retries**. The current pump persists `prepared` as its source; change that point so conversion does not overwrite the original Blob/name/type with the lossy result. Preparation for an attempt is transient; a retry after disabling compression must use the original. Existing previews may be reused only on an unchanged source. Check original size before reading and output size before transfer.
8. Store `preferences: { compressImages: true }` in the encrypted catalog. Missing preference in an existing vault reads as true; false must survive unlock, restart and master-password change. Add serialized, unlocked-only `vault.preferences.update({ compressImages })` with strict boolean validation and unknown-field rejection. Update snapshots/client projections/store facade and broadcast the committed preference to all pages. Clear decrypted preferences on lock/reset; recovery export continues to contain identities only.
9. Expose a checkbox labeled “Compress images before upload” in Vault Settings with a short WebP/lossy explanation. Put progress/error beside it, disable overlapping writes, and restore the last committed value on failure. Changing it affects later queued/retried jobs, not an attempt already preparing. Do not implement the component-store refactor from 45 here.

## Acceptance cases

| Case | Required result |
| --- | --- |
| Static JPEG/PNG, smaller valid WebP | Converted name/type/size and oriented dimensions; preview and downloaded bytes agree |
| PNG with transparent pixels | Alpha retained; no opaque background fill |
| GIF/APNG/WebP/other file | Original bytes/name/type retained |
| MIME missing or contradictory | Decide eligibility from validated bytes; unsafe ambiguity falls back |
| Unsupported WebP, malformed input, encoder/decode failure, output not smaller | Original uploaded; batch continues |
| Aborted preparation or vault/identity reset | No fallback upload, late completion, progress or object URL |
| Preference off | Original uploaded; thumbnail behavior retained |
| Preference toggled while job A prepares and B waits | A uses captured value; B uses latest committed value |
| Converted attempt fails, setting disabled before retry | Retry uploads original source |
| Lock/restart, old vault missing preference, failed preference commit | Default/committed state remains correct in both clients; encrypted persistence only |

## Verification

Add helper/conversion tests beside `media.test.js`/`thumbnail.test.js` or one focused `image-preparation.test.js`, using stub bitmap/encoder functions for deterministic failure/cancellation cases. Extend `vault.test.js` for encrypted preference commits/defaults and service/library tests for queue timing and original-source retention.

Use real Firefox/Chromium browser uploads for landscape, portrait with EXIF orientation, panorama, transparent PNG and APNG. Verify downloadable signatures/dimensions/metadata, not only card appearance. Exercise web and extension owner paths; the browser shim alone does not prove installed-extension encoder support. Record which host actually supports conversion and which falls back. Inspect Firefox narrow light/dark library and setting screenshots. Run client checks and extension build from the guide; retain existing content-hash/vector tests unchanged.

## Implementation notes

Record browser/host support observed, fixture dimensions and file sizes, resource cap, preference behavior, and any unavailable installed-extension verification. Do not describe support as tested until exercised.
