# Remove obsolete authority and tooling

## Goal and scope

Audit Rust runtime, CLI, maintenance, extension, workers, tests, fixtures, scripts and docs. Remove device/recovery/epoch/rotation/HPKE paths and dependencies. Keep HTTP policy in routes/auth, transaction invariants in db and encoding in protocol. Update browser fixtures without executing them. Mark old specs historical and publish current contracts.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Affected Rust/client tests, build-content checks and scoped static/formatting checks. Audit obsolete references and seed-boundary import callers.

Implement as one cohesive commit after affected checks pass and builds are warning-free.

## Final lifecycle audit

Preserve the previously covered independent-tab, failed persistence, interrupted
creation, download failure, and forgetting invariants using shared credentials.
A backup made before registration may be restored: if its checkpoint is genesis
and the server returns an explicit unknown-library 401, retain the restored seed
as a prepared library and require a fresh backup download before registration.
Never reinterpret network errors, invalid history, or non-genesis checkpoints as
permission to create a new library. Received pairing credentials never take this
creation path. Cancellation disposes identities not yet owned by a session; a
failed local write must not start registration or clear cached rollback protection.
