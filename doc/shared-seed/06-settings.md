# Present minimal setup and settings

## Goal and scope

Setup offers Create, Restore backup, Connect. Settings shows library address/usage, Connect another browser, Library backup, upload preferences, local password, Forget this browser and About. Delete devices/recovery/rotation controls. Views subscribe to explicit stores; components use plain state/callbacks only, one presentation responsibility, no HTML IDs. Errors stay beside actions.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Affected store tests, Svelte/TypeScript/Biome and warning-free build. Browser tests/screenshots remain pending explicit approval.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
