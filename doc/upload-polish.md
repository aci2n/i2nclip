# Upload preparation and settings refinements

## Goal and scope

Apply the user's follow-up fixes: allow conversion before rejecting oversized
media, compact the upload review, collapse Settings sections, display converted
filenames during upload, use module-scope imports and one media preparation
interface, and remove duplicate pairing cancellation requests. No server/schema,
encryption, new codec, persistent queue or preference-format changes.

## Interfaces, ownership and lifecycle

Expose one convertMedia request interface for image/video dispatch, source/output
size policy, callbacks and cancellation; keep codec implementations in matching
image/video modules. Upload preparation calls only this interface. Replace dynamic
and inline type imports in this conversion path with module-scope imports. This
explicitly replaces the earlier lazy-loading decision. No plugin/codec polyfills.

The source file's size is inspected before reading: disabled uploads and files
with no enabled applicable converter reject immediately. Eligible oversized media
gets a conversion attempt. Enforce the effective server/protocol file limit on the
selected output before reading prepared bytes/encryption/networking; if conversion
fails or cannot reduce below the limit, reject that file and continue the batch.
Keep the encrypted-byte limit and streaming download limits unchanged. Extension
handoff must not reject eligible oversized media before this shared preparation.
Cancellation never falls back or publishes stale prepared names/progress.

Add a prepared-name callback to upload preparation. The upload store retains only
the name, updates active progress after conversion and uses it for completion and
subsequent failures; original-file fallback retains the original name. The pending
queue remains root-owned, independent and memory-only.

Settings sections use native details/summary, with only the library/setup section
open on entry; Upload options, recovery, pairing, forget and password sections
start closed. About stays a dialog action. Disclosure state is presentation-only
and resets when navigating away. No HTML IDs or component store/workflow access.

Compact each pending file into a filename/size row with an icon removal action
and inline collapsed options summary. Put summaries on the row where room permits,
wrap cleanly at 320/360px, and reduce padding/gaps without shrinking action hit
areas below accessible touch sizes. Keep per-file options/defaults and batch
Start/Cancel behavior; omit repetitive unchanged-file paragraphs.

Pairing cleanup consumes ownership of the room before issuing its bounded DELETE.
Re-entered cleanup must not dispose resources or delete the same room again.
Cancellation before create/join returns must still delete a late-attached room
exactly once. Do not suppress 404s to hide duplicate requests.

## Acceptance checks

Test oversized image/video conversion accepted below limit, fallback/oversized
output rejected, disabled/ineligible uploads rejected before reads, extension
handoff policy and unchanged crypto limits. Test converted/original names in
progress/completion and stale callbacks. Test single pairing DELETE on normal
cancel, repeated cancel/dispose, expiry and late room attachment. Verify Settings
default disclosure state, compact review, mixed media and errors in both themes
and at desktop/320/360px. Run unit/static/build checks and Firefox/Chromium E2E
against isolated real server/databases; inspect actual Firefox screenshots.
