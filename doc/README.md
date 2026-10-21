# Documentation

Current architecture and wire contracts: [chain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [protocol](protocol.md). Read these before changing persistence, keys, pairing, or API behavior.

Other design notes record earlier changes. Where they conflict with these specifications, the current chain specifications take precedence.


- [Protocol](protocol.md): HTTP API, signatures, frames, quotas, concurrency, and transfer limits.
- [Cryptography](crypto.md): keys, encrypted formats, and security boundaries.
- [Client ownership](session.md): stores, independent tab sessions, uploads, previews, and disposal.
- [IndexedDB sessions](indexeddb-session.md): browser storage, remembered access, and local Lock.
- [Firefox extension](extension-bridge.md): setup, capture, File handoff, and lifecycle.
- [Device pairing](pairing.md): verification, identity transfer, and the relay API.
- [Database migrations](database-migrations.md): startup, migration history, and adding schema changes.
- [Test pipeline](test-pipeline.md): commands, toolchains, and fixture isolation.
- [Resource profiling](postgresql-profile.md): optional measurements and reproduction.
- [Improvement priorities](priorities.md): open topics requiring separate specifications.
- [Chunk uploads specification](chunk-uploads.md): independently encrypted chunks and browser streaming; implemented.
- [Transfer and shutdown deadlines](transfer-shutdown-proposal.md): implemented resource and shutdown limits.
- [Blockchain storage specification](blockchain-storage.md): encrypted operation chain, device authority, deletable blobs, and implementation commits; implementation in progress.
- [Library recovery](library-recovery.md): fixed recovery authority, deterministic epoch keys, recovery without an authorized device, and generated backup passwords; authoritative amendment to the chain specification.

Current behavior is documented separately from proposed work. The Rust server is
in `src/`; the web app and extension are in `client/`. Historical change specifications remain in this directory and Git history;
use the documents linked above for current behavior.
