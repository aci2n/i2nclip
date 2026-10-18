# Upload preparation and Settings refinements

Upload preparation checks source eligibility and selected-output size separately
from image encoding and transport. Eligible oversized images may compress to WebP;
selected output must fit the effective file limit before reading upload bytes.
The upload store publishes actual prepared names and suppresses stale callbacks.
See [upload simplification](upload-simplification.md) for the current specification.

Settings sections use native details/summary, with only the library/setup section
open on entry. Uploads, recovery, pairing, forget and password sections start
closed. About stays a dialog action. Disclosure state is presentation-only and
resets when navigating away. Components use plain props/callbacks without stores,
async application workflows or HTML IDs.

Pairing cleanup consumes ownership of the room before issuing its bounded DELETE.
Re-entered cleanup must not dispose resources or delete the same room again.
Cancellation before create/join returns must still delete a late-attached room
exactly once. Do not suppress 404s to hide duplicate requests. Verify normal and
repeated cancel/dispose, expiry and late room attachment.
