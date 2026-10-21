# Transfer credentials through the PAKE channel

## Goal and scope

Use five relay messages: PAKE initiation/response/completion, authenticated encrypted credential plus challenge, authenticated acknowledgment. Require matching human verification codes and sender approval before transfer. Persist and verify through the supplied checkpoint before acknowledgment. No chain writes or receiver identity. Remove HPKE, ephemeral recipient bindings, obsolete adapters and hpke dependency. Losing acknowledgment can leave receiver connected; cancellation cannot retract a delivered seed.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

PAKE/packet/relay/store tests, wrong code/origin/checkpoint, persistence/replay failure, lost acknowledgment, cancellation and expired rooms.

Implement as one cohesive commit after affected checks pass and builds are warning-free.
