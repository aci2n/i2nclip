# Upload and preview improvements

Implement three independently verified commits: WebP compression, text previews,
and mobile CSS. Deep links, server interfaces, schema, public sharing, text
editing, resizing, and new dependencies are excluded.

Application owns a device-local preferences store, created after tab admission.
It persists a compression boolean separately from identity, defaulting to true;
recovery and pairing do not transfer it. Settings subscribes and passes plain
state/callbacks to a presentation component. Upload batches snapshot the preference
and shared preparation converts JPEG/PNG to WebP at quality 0.85, preserving
size and transparency. Keep originals on conversion failure, non-WebP output, or
larger output. Check input size before decoding. Converted files receive matching
names, MIME types, sizes, and thumbnails. Cancellation propagates; bitmaps close
on all paths. Existing sequential batches and session invalidation remain.

Text previews recognize text MIME types, JSON/XML, and the agreed common text/code
extensions. Existing image/audio/video preview classification takes precedence.
Media-item stores decode at most 256 KiB of verified decrypted content as UTF-8,
retain the preview string in memory, and clear it on disposal. The existing dialog
renders escaped text with a truncation label and no executable markup. Downloads
retain the complete original. Components own presentation only.

Mobile changes stay in component styles: comfortable tag controls, wrapping long
chips/actions, navigation spacing, and preview padding. Preserve keyboard/focus,
failed drafts, themes, and resource ownership.

Acceptance: compression preference persistence and batch snapshots; smaller/larger
output, conversion failure/cancellation, metadata consistency; text recognition,
escaping/truncation/empty content/disposal; client unit tests, Biome/Svelte checks,
builds, Firefox/Chromium end-to-end coverage and actual Firefox screenshots in
both themes at desktop and 320/360 px, with long tags/names and realistic media.
