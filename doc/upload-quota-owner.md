# One owner for the upload quota check

Audit item B4.

## Goal

The quota formula (file count and encrypted content bytes against the library
limits) exists twice: in `stores/uploads.ts`, with a compression exemption, and in
`services/files.ts`. Keep it only in the files service. The uploads store keeps
its early rejection, which avoids preparation and thumbnail work for files that
cannot fit, but asks the files service for it.

## Behavior

- `Files.checkQuota(size, signal)` reads the current quota and rejects with "This
  file exceeds the available storage quota." when no file slot is free or the
  encrypted content for `size` bytes does not fit. `upload` uses the same check
  before reading bytes and keeps its later check of all encrypted objects.
- The uploads store checks once per file: before preparation for files that
  will not be compressed, and after preparation for eligible images, whose
  compressed size decides whether they fit. Thumbnails are produced only after
  that check.
- The uploads store no longer receives the API; quota reads belong to the
  files service.

## Exclusions

No quota caching or reservation; the server stays authoritative.

## Acceptance checks

- Unsupported sizes are rejected before preparation or quota reads.
- An oversized eligible image that compresses under quota uploads; one that does
  not is rejected before thumbnail work; an oversized non-image is rejected
  before preparation.
- The files service still rejects an over-quota source before reading bytes.
- `make -C client test`.
