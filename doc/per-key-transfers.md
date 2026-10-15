# Per-key transfer admission

## Goal and interfaces

Allow one active upload and two active content downloads per authenticated public
key, shared by all devices using that key within a server instance. Retain global
four-upload/sixteen-download limits and the existing waiting admission behavior.
No HTTP shape, persistence, client, encryption, or database changes.

## Ownership and lifecycle

Keep the keyed semaphore registry in a separate transfer module and share it
through AppState. Acquire the per-key permit before the global permit so requests
queued for one key do not consume global capacity. Authenticate headers before
upload admission; verify empty download bodies before download admission.

Upload permits cover body reading, hashing, and database completion. Download
permits cover lookup and response-body draining, including partial reads. Drop
both on errors or cancellation. Admission waits remain unbounded, and body
deadlines start after admission, as before. Quota/metadata/list endpoints do not
consume transfer permits. Keys identify users; IP addresses do not.

Store Weak semaphore references, pruning dead entries on admission. Waiting and
owned permits keep their semaphore alive; inactive identities do not accumulate
in the registry. No new dependencies, settings, background tasks, or persistent
state. Each server instance enforces its own limits.

## Acceptance checks

Test one upload/two downloads per key, independent keys and directions, queued
cancellation, dead-entry reclamation, global saturation, and admission ordering.
Use real isolated PostgreSQL API tests to hold upload bodies and download
responses, verify other keys proceed, and verify errors/drop/drain release permits.
Update existing global-upload saturation tests to use distinct keys. Run Rust
tests, PostgreSQL tests, formatting, and warning-free builds/Clippy, then commit
this separately from quota/UI and IP rate limiting.
