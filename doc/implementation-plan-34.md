# Implementation plan: item 34 — Image compression before upload

## Goal

Compress eligible images before encryption and upload, enabled by default with a user setting to disable it. Preserve the original when conversion is unsupported or fails.

## Changes

- Add a shared image-preparation step to the common upload path, after bounded source preparation and before thumbnail generation, encryption, and transfer. Keep non-image media unchanged.
- Use browser decoding and canvas encoding already used by thumbnail generation. Convert static JPEG and PNG images to WebP when the browser can produce WebP; skip GIF and other formats to avoid losing animation or unsupported content. Detect unsupported output rather than trusting the requested MIME type.
- Preserve image dimensions, orientation, and alpha. Detect APNG's animation-control chunk and skip animated PNGs. Use WebP quality 0.82; avoid conversion when output is not smaller than the original. Give converted files a `.webp` name and content type.
- Add an encrypted vault preference, `compressImages`, defaulting to true for new and existing vaults. Expose it as a checkbox in Vault Settings and a `vault.preferences.update({ compressImages })` owner command; publish the value in the vault state so all open pages use it. Apply changes to later queued jobs, not a job already being prepared. Keep this local preference out of portable recovery exports.
- Treat decode, canvas, and encode failures as a safe fallback to the original file. Honor cancellation and size limits before and after conversion; release bitmap/canvas resources promptly.
- Inspect support in the project's Firefox and Chromium targets and record the tested behavior in the plan's implementation notes.

## Acceptance

- Unit tests cover lossy image conversion, smaller-output selection, unsupported WebP, decode/encode failure fallback, disabled preference, non-image pass-through, and cancellation.
- Browser tests upload landscape, portrait, and panorama images, verify dimensions and preview, and exercise the setting in both browsers.
- Run client tests, Svelte checks, lint, and the relevant browser scenarios; inspect narrow light/dark screenshots. Confirm the encrypted metadata describes the converted bytes and that non-images retain their existing behavior.
