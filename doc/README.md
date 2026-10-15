# Project documentation

- [Final refactor review](refactor-review.md): phase 12–16 results, verification, and suggested follow-ups.
- [Client ownership](session.md): singleton stores, tab admission, persistence, and disposal.
- [Test pipeline](test-pipeline.md): fresh-clone preparation, fixture ownership, and acceptance checks.
- [Protocol](protocol.md): HTTP API, signed requests, frames, limits, and storage semantics.
- [Cryptography](crypto.md): algorithms, key derivation, encrypted formats, and security boundaries.
- [Image previews](image-preview-navigation.md): navigation, loading progress, and ownership.
- [Firefox extension](extension-bridge.md): setup, captures, File handoff, and lifecycle.
- [Device pairing](pairing.md): verification and identity transfer through the relay API.
- [Database concurrency audit](database-concurrency-audit.md): query isolation and transactional behavior.
- [Request limits](request-limits.md): body deadlines, byte caps, and separate upload/download admission.
- [Resource profile](postgresql-profile.md): process sampling, measurements, and reproduction.
- [Improvement priorities](priorities.md): suggestions requiring separate specifications.
- [Transfer and shutdown proposal](transfer-shutdown-proposal.md): proposed deadlines; not implemented.

The Rust server is in `src/`; the web app is in `client/`. HTTP handlers contain no SQL. `src/crypto.rs` holds server-used cryptography; `src/reference_crypto.rs` is a test-only reference client sharing vectors with JavaScript. Current schemas and formats are greenfield and have no compatibility layers.
