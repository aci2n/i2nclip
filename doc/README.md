# Backend review and protocol documentation

- [PostgreSQL storage plan](postgresql-plan.md): agreed application, deployment, and verification scope.
- [PostgreSQL process profile](postgresql-profile.md): separate server/client memory measurements, PostgreSQL process sampling, and reproduction steps.
- [Protocol](protocol.md): HTTP API, signed requests, frames, limits, and storage semantics.
- [Cryptography](crypto.md): exact algorithms, key derivation, encrypted formats, and security boundaries.
- [Backend review](backend-review.md): findings, priorities, simplification opportunities, and verification.
- [Priorities and implementation scope](priorities.md): completed work, remaining ordered changes, and the next approval boundary.
- [Request limits and admission](request-limits.md): implemented body-read deadlines, endpoint caps, and separate two-slot upload/download admission.

These documents describe the working tree reviewed on 2026-10-10 and subsequent upload receipt removal, strict Ed25519 validation, browser-compatible origin normalization, body-read deadlines, endpoint-specific byte caps, upload/download admission, and content-hash identifiers with transactional PostgreSQL content storage. Other recommendations remain proposals; their status is tracked in the priority list. The Rust server is in `src/`; the corresponding browser implementation is in `client/src/lib/protocol/` and `client/src/lib/api.js`. Unrelated frontend work is preserved.

HTTP modules use the flat `src/` directory: `routes.rs` assembles the router, serves health/registration, and provides shared HTTP helpers; `media.rs` owns media routes, the private `MediaRequest` extractor, query parsing, admission, and media responses. `auth.rs` retains signature, nonce, and body-hash verification.

The current content hash policy, exact storage ordering, crash limits, and retry behavior are described in [protocol.md](protocol.md); metadata/content AAD and hash checks are in [crypto.md](crypto.md). Current formats retain their version labels and require no compatibility layer.


`src/crypto.rs` contains server-used cryptography. `src/reference_crypto.rs` is a test-only reference client, shared by unit and API tests; encryption and key-derivation dependencies stay out of the production dependency graph.
