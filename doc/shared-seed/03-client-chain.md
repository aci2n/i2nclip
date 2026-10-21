# Verify a fixed-authority chain

## Goal and scope

Use the fixed genesis key and eight-field block body. Remove epoch maps, membership reduction, recovery callbacks and rotation. Keep signature/AAD/hash domains, random block salts/nonces, encrypted file operations, cache CAS, monotonic checkpoints, exact retries, selected historical materialization and live purge availability. Runtime credentials contain handles, never seed bytes.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Client chain, cache, reducer, materialized-view, file workflows and cross-language vectors. Invalid signed operations cannot advance trusted state.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
