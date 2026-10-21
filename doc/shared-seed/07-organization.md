# Normalize ownership and folders

## Goal and scope

Audit all client modules. protocol contains stateless transformations; services contains resource owners/transports/file workflows and the critical identity boundary; storage contains IndexedDB/session/cache; stores contains observable application workflows. Retain focused media/streaming/ui folders. Remove redundant chain- store prefixes. Stateful owners use private classes, bound public commands and private workflow methods. Move verification into session. No generic lifecycle framework/barrels/compatibility adapters.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Affected owner tests, detached commands, explicit startup, cancellation, repeated disposal and client static/build checks.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
