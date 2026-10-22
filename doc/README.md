# Documentation

Current wire and credential contract: [protocol](protocol.md) and the
[shared-seed contract](shared-seed/README.md). One shared library seed grants
full authority; there are no device keys, epochs, recovery principals or
rotation. Read these before changing persistence, keys, pairing, or API behavior.
[Blockchain storage](blockchain-storage.md) remains the reference for encrypted
objects, file operations, storage effects and purge where it does not conflict.

Other design notes record earlier changes. Where they conflict with the current
contract, the current contract takes precedence.

- [Protocol](protocol.md): identity, blocks, HTTP API, credentials, backups, and pairing transfer.
- [Shared-seed cutover](shared-seed/README.md): approved contract and per-commit specifications.
- [Blockchain storage specification](blockchain-storage.md): encrypted objects, file operations, storage effects, quotas and purge; partly historical.
- [Firefox extension](extension-bridge.md): setup, capture, File handoff, and lifecycle.
- [Database migrations](database-migrations.md): startup, migration history, and adding schema changes.
- [Test pipeline](test-pipeline.md): commands, toolchains, and fixture isolation.
- [Resource profiling](postgresql-profile.md): optional measurements and reproduction.
- [Improvement priorities](priorities.md): open topics requiring separate specifications.
- [Chunk uploads specification](chunk-uploads.md): independently encrypted chunks and browser streaming; implemented.
- [Large-file test size](large-file-test-size.md): bounded browser transfer fixture and its coverage rationale.
- [Transfer and shutdown deadlines](transfer-shutdown-proposal.md): implemented resource and shutdown limits.
- Historical: [cryptography](crypto.md), [client ownership](session.md),
  [IndexedDB sessions](indexeddb-session.md), [device pairing](pairing.md)
  (its relay API section remains current), [library recovery](library-recovery.md),
  [device-preserving rotation](device-preserving-rotation.md),
  [genesis and enrollment](genesis-and-recovery-enrollment.md), and
  [chain verification](chain-verification.md).

Current behavior is documented separately from proposed work. The Rust server is
in `src/`; the web app and extension are in `client/`. Historical change specifications remain in this directory and Git history;
use the documents linked above for current behavior.

## Review notes

- [Branch review — 2026-10-21](branch-review-2026-10-21.md): findings against
  `a70fceb` covering storage redundancy, ownership, crypto design, and security;
  observations for later review, not an implementation specification.
- [Project audit — 2026-10-22](audit-2026-10-22.md): findings against `36e26a9`
  covering crypto risks, reliability, usability, simplification, and a proposed
  order for follow-up change specifications.
