# Project documentation

- [Protocol](protocol.md): HTTP API, signatures, frames, quotas, concurrency, and transfer limits.
- [Cryptography](crypto.md): keys, encrypted formats, and security boundaries.
- [Client ownership](session.md): stores, tab admission, uploads, previews, and disposal.
- [Firefox extension](extension-bridge.md): setup, capture, File handoff, and lifecycle.
- [Device pairing](pairing.md): verification, identity transfer, and the relay API.
- [Database migrations](database-migrations.md): startup, migration history, and adding schema changes.
- [Test pipeline](test-pipeline.md): commands, toolchains, and fixture isolation.
- [Resource profiling](postgresql-profile.md): optional measurements and reproduction.
- [Improvement priorities](priorities.md): open topics requiring separate specifications.
- [Transfer and shutdown proposal](transfer-shutdown-proposal.md): unimplemented deadline proposal.

Current behavior is documented separately from proposed work. The Rust server is
in `src/`; the web app and extension are in `client/`. Completed implementation
plans and verification reports live in Git history rather than this directory.
