# Replace membership with fixed library authority

## Goal and scope

Replace library_keys and epochs with one immutable libraries.signing_public_key. Genesis is [1, public_key], registration [invitation, genesis]. Block bodies are [1, library, sequence, previous, effects, salt, nonce, ciphertext]. Initial head is sequence zero. All normal HTTP routes require registered authority before nonce/transfer admission. Registration alone uses four isolated non-queuing slots; invalid registration spends no nonce/invitation. Nonce and successful registration commit atomically. Edit greenfield sql/001_init.sql; fresh databases required.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Rust codec/auth/admission tests and affected isolated PostgreSQL database/API tests, including unknown-key stalls, exact registration retry, invalid invitation rollback, concurrent appends, quotas and purge.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
