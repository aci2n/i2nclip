> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Configurable per-file quota

Historical specification, superseded by [chunk uploads](chunk-uploads.md).

## Goal and scope

Expose `max_file_plaintext_bytes` through persisted key quotas, invitations,
`StorageLimits`, `GET /api/quota`, and `--max-file-plaintext-bytes` on the key
and invitation CLI. Default to 33,554,432 bytes (32 MiB); accept zero through
536,870,912 bytes (512 MiB). Zero blocks uploads, including empty files.
The key CLI requires all three limits; invitation issuance defaults this limit.

## Ownership, persistence and lifecycle

A new SQLx migration adds the column to key_quotas and registration_codes with
the default and range checks, and raises the files content envelope ceiling.
Existing data and applied migrations remain unchanged. Invitations transfer the
limit to new keys; registering an existing key preserves limits. Lowering this
limit neither scans nor deletes existing files and does not prevent downloads.
The server derives request bounds from the authenticated quota and rechecks the
plaintext length (validated AES-GCM ciphertext length minus its 16-byte tag)
under the quota-row lock, preserving duplicate precedence and atomic counters.

The workspace owns the in-memory quota store, its initial refresh, cancellation
and disposal. Navigation preserves it; identity/server/session changes dispose
it. The application forwards quota and uploads as explicit Settings props; Settings
does not receive its owning workspace. Settings retains entry/post-upload refresh
and Retry behavior.
Uploads use the current limit, or 32 MiB when quota is unavailable; zero is never
replaced by the fallback. Inspect original file size before reading. Reject ineligible/disabled uploads
immediately; give enabled media encoders a chance to produce output below the
limit. Check the selected file before reading prepared bytes and recheck prepared
bytes before encryption. Per-file failures continue the batch.
Web extension handoff uses the workspace limit when available. The standalone
extension capture cap remains unchanged.
Downloads cap actual streamed bytes using the item's encrypted byte count plus
an absolute protocol ceiling, independently of current quota. Verify the hash
before decrypting. Settings displays the CLI-compatible base64url public key
and the per-file limit, with wrapping and no HTML IDs.

## Failure and cancellation

Per-file quota rejection returns HTTP 409 with a specific message; body bounds
may reject oversized requests before decoding. Failed mutations change no usage.
Concurrent quota updates serialize with media mutations. Reads deduplicate and
ignore aborted/stale results. Failed quota reads expose Retry and activate the
client fallback; no polling or persistent cache is introduced. Existing media
resource ownership, aborts, URL cleanup and transfer permits remain in force.

## Exclusions

No encryption-format changes, storage redesign, transfer streaming redesign,
standalone extension negotiation, cross-tab coordination or new dependencies.
Server upload/download and browser encryption/decryption remain buffered;
server download streaming is separate work.

## Acceptance

Cover migration defaults/upgrades/restarts, invitation inheritance and existing
key preservation; CLI required/default/range handling; exact boundary, zero,
one-byte-over, >32 MiB and concurrent quota updates; failure accounting and
existing downloads after lowering limits. Cover workspace initial loading,
navigation/disposal, fallback, pre-read rejection, sequential upload failures,
bounded downloads without trustworthy Content-Length and direct links. Run
format/lint, client/unit/type/build, PostgreSQL and relevant browser checks.
Inspect Firefox Settings screenshots in both themes and at 320/360 px widths.
