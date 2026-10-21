# Own shared credentials in the session

## Goal and scope

Session owns the opaque identity. Save prepared credentials before registration. Keep only a local registration-pending flag. Restore/import verifies identity and trusted history before activation. Backup contains credentials only, with a generated password and initial download gate; interrupted preparation can regenerate its backup. Persistence receives sealed credentials and never decoded seed-bearing documents. Root resources survive navigation and end on Lock/Forget/session replacement.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Session, storage, password changes, remembered access, interrupted registration/import, stale completion, disposal, independent tabs and backup failure tests.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
