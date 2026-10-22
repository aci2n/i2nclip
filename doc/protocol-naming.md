> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# Upload document naming

Rename the HTTP-verb-based PostParts/PostDocument and decode_post/encode_post
helpers to UploadParts/UploadDocument and decode_upload/encode_upload. Rename
the matching JavaScript encoder to encodeUpload, updating application callers,
reference encoders, tests and profiling. The goal is to name the entire upload
payload (content, metadata and tags), rather than only its HTTP verb or content.

This is an internal naming change only. Keep MessagePack fields and encoded
bytes, public HTTP routes, signing/hashing, borrowing, validation, persistence,
resource ownership, cancellation and failure behavior unchanged. No aliases,
compatibility wrappers, new abstractions, dependencies or capabilities.

Acceptance: no old upload identifiers or TODO remain; existing interoperability,
frame allocation/validation and API tests pass; all Rust targets and the client
build without warnings. No additional behavior tests are needed for renaming.
