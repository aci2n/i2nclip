# MessagePack cutover specification

## Goal and scope

On branch msgpack, replace application-owned JSON and length-prefixed frames with
MessagePack named maps and snake_case fields. Include HTTP documents/errors,
metadata plaintext, encryption envelopes, pairing, identities, password records,
recovery files and local preferences. No compatibility decoder, artifact backfill,
automatic data deletion, new workflow, polling or dependency beyond codecs.
Deploy client/server together using fresh application data and recovery files.

Use @msgpack/msgpack and rmp-serde/serde_bytes. Encode exactly one document;
reject malformed data and trailing values. Binary fields use bin. Application
document objects use snake_case directly, without a case-conversion framework.
Authentication headers, signing grammar, algorithms, keys and AAD are unchanged.
Browser-native extension messages, platform manifests and test vectors stay native.

## Interfaces

- Upload: {meta: bin, content: bin, tags: [{token: bin, label: bin}]}.
- Update: {prev_meta_hash: bin, meta: bin, tags: [...]}.
- Catalog: {tags: [{token: bin, label: bin}]}.
- API documents retain their named fields, snake_case, and use application/msgpack.
  Media metadata is bin; textual IDs, URL tokens and bearer credentials remain text.
- Metadata plaintext: {metadata: map, thumb: bin|null}; preserve extensible fields.
- Encryption envelope: {v: 1, iv: bin, ct: bin}. Password envelopes also carry
  salt and iterations. Content IDs hash the exact encoded content envelope.
- Private key: {v: 1, seed: bin, public_key: bin}; identity:
  {server_url: string, private_key: key-document}. Copy owned key buffers before
  wiping temporary decrypted/derivation buffers.
- Recovery: {format: "i2nclip-recovery", v: 1, encrypted: password-envelope}.
  Download i2nclip-recovery.msgpack and import bytes after size validation.
- LocalStorage values are base64-wrapped MessagePack, maintaining atomic writes.
- Pairing relays opaque binary messages, including encoded library-owned OPAQUE
  representations; transfer and acknowledgment documents also use MessagePack.

## Ownership, persistence and failures

Stores retain async work, cancellation, generation guards, stale-result rejection,
deferred refresh, upload batching and URL disposal. Components get plain props.
Preserve status codes, empty bodies, HTTP authentication order, no-store policies,
immutable content caching, admission/quotas and pairing verification/expiry.
Downloads hash-check stored bytes before decoding/decrypting. Existing malformed
catalog records remain individually skippable; broken documents fail the request.
Invalid responses use existing error feedback and HTTP status-text fallback.

Keep database tokens as base64url text and sealed bytes as bytea. Migration 004
removes the label version-byte check, retaining empty-label and size bounds;
server envelope validation replaces that check. Applied migrations are unchanged.
Keep all application limits, including the 96 KiB tag budget; recompute outer
request caps. Borrow request content and metadata in Rust: no content-sized decode
copy. Keep JavaScript numeric semantics and third-party API representations.

## Sequence and acceptance

Use small cohesive commits: codecs/vectors; serialization seams; envelopes and
migration; metadata/media/tags; other HTTP documents; identity/recovery/persistence;
pairing; docs/final checks. Keep dependent producers/consumers together.
Verify focused behavior and warning-free builds before committing.

Cover interoperability, exact-byte signing/hashing, malformed/trailing documents,
field/body boundaries, borrowed-buffer allocation, Unicode tags, ownership,
conflicts, quotas, migration preservation and partial catalog corruption.
Exercise setup/reload/unlock/password changes/recovery/pairing/cancellation and
extension uploads. Run make test-all, inspect Firefox setup/recovery screenshots,
and preserve test database/listener/browser isolation and cleanup.
