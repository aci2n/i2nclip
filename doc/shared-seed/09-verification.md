# Record non-browser integration verification

## Goal and scope

Run the union of affected non-browser tests after integration without repeating unrelated checks. Verify fresh database initialization/reopening, registration/body admission, chain trust and resource ownership. Record actual results and all browser coverage as pending. Do not run make test-all, E2E, screenshots or resource profiling without explicit approval.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Affected non-browser test union, clean builds and final diff/dependency/authority-boundary audit.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
