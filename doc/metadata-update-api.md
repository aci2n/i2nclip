# Generic metadata updates

## Goal and scope

Allow callers to update a file's name, tags, or both through the same metadata
workflow. The existing signed `PUT /api/media/{id}/meta` already accepts the
entire encrypted metadata frame and tag fingerprints. Keep that endpoint and
encryption protocol; the server never receives a plaintext filename.

Generalize `media.retag(tags)` to `media.updateMetadata(patch)`, and the matching
library method to `library.updateMetadata(id, patch)`. Merge the supplied ordinary
metadata object into the current metadata, normalize supplied tags, and retain
all fields not supplied plus the existing thumbnail. The tag editor delegates
through this generic method with `{ tags }`. Rename the Rust tag-specific handler
to `update_metadata` to reflect the existing generic endpoint behavior.

Exclude a filename editor or other new UI, new endpoints, schema changes, content
rewrites, upload changes, migrations, and additional persistence. The HTTP API
continues to accept a complete encrypted metadata frame; patching belongs to the
client store that already owns the decrypted metadata.

## Ownership and lifecycle

The media-item store owns merging, busy rejection, async encryption/request
workflow, stale-session checks, metadata state, and error feedback. Components
continue to use ordinary callback props. The low-level `api.updateMetadata`
remains independent of rendering. Successful changes appear in store metadata
and existing download filenames; content IDs, encrypted content, and cached media
bytes/URLs remain the same.

Use the current prior-ciphertext hash for optimistic concurrency. A conflict
loads the server's current metadata and returns false with a generic metadata
error; caller-owned drafts can retry without overwriting concurrent edits.
Failed, aborted, stale, or overlapping requests do not publish an attempted name
or tags. No local-storage writes or new resources are introduced.

## Acceptance checks

- Updating `{ name }` preserves tags, dimensions/type/size, other metadata fields, and
  thumbnail, and sends the existing prior metadata hash to `/meta`.
- Updating `{ tags }` preserves the name and normalizes/deduplicates tags; a
  combined update changes both in a single metadata write.
- Successful encrypted updates decrypt to the new filename; plaintext names are
  absent from the wire, content identifiers stay unchanged, and conflict data is
  loaded without publishing stale attempted edits.
- Busy, failure, disposal, and session-cancellation behavior remains consistent
  with existing media-item ownership. Meaningful isolated client tests cover name
  updates and conflicts; Rust builds/static checks and existing tests pass.

## Verification

All 83 client cases, Svelte checking, 33 Rust unit/configuration cases, seven
PostgreSQL metadata/concurrency cases, and all 16 Firefox/Chromium browser cases
pass. The real-server browser checks rename a panorama, verify its downloaded
filename and unchanged bytes, reject a stale edit, and update name/tags together.
Package checks, formatting, lint, and Clippy with warnings denied also pass.

## Explicit upload fields and arbitrary extensions

Goal: distinguish required upload inputs from arbitrary JSON extensions without
calling both complete and partial objects metadata. api.upload accepts explicit
name/contentType/tags/image arguments alongside bytes, thumbnail, credentials,
progress, and cancellation, plus optional extra = {} for arbitrary properties.
Size is derived from bytes rather than accepted independently. It constructs the
complete metadata JSON from extra followed by normalized authoritative fields.
Generated image information overrides an image supplied through extra.

sendUpload supplies the File name/type and generated image details explicitly.
Library batches and extension file handoffs call their optional extensions extra
throughout; the receiver retains extra with pending captures until unlock. Only
the complete encrypted/decrypted JSON is called metadata. Stored JSON uses
camelCase keys (contentType/sourceUrl/sourceTitle), read directly by the app
without conversion. Thumbnail bytes stay outside the JSON in the encrypted
envelope. Rename current metadata fields directly, with no old-key aliases.

No migrations, aliases, fallback interfaces, server schema changes, new state,
or dependencies. Existing snake_case records are not translated. Arbitrary properties cannot override name/type/size/tags supplied
by normal upload inputs. Preserve signatures, AAD/hash bindings, cancellation,
limits, generic metadata editing, and source display. Fixed crypto-vector bytes
are independent of the metadata schema and remain unchanged. Acceptance: explicit upload
arguments, camelCase stored JSON, extra consistently passed end to end, source
survives encryption/edits,
no partial metadata alias, updated callers/fixtures, and warning-free build/static
checks. Do not add or run tests unless requested.
