# Backend review and protocol documentation

- [Protocol](protocol.md): HTTP API, signed requests, frames, limits, and storage semantics.
- [Cryptography](crypto.md): exact algorithms, key derivation, encrypted formats, and security boundaries.
- [Backend review](backend-review.md): findings, priorities, simplification opportunities, and verification.

These documents describe the current working tree reviewed on 2026-10-10. Recommendations are not implemented changes. The Rust server is in `src/`; the corresponding browser implementation is in `client/src/lib/protocol/` and `client/src/lib/api.js`. Existing frontend work was left untouched.
