# Isolate the shared library seed

## Goal and scope

Introduce the critical private identity owner, native Ed25519 seed generation/import, HKDF encryption-root derivation, genesis, sealed local credentials, encrypted credential backup and authenticated pairing transfer. Only session and pairing orchestration may import this boundary; they receive opaque handles or ciphertext. Preserve random data keys. No new dependencies.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Identity, backup, derivation, public-key correspondence, buffer ownership, disposal, cancellation, and import-boundary checks.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
