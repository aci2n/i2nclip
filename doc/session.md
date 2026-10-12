# Session ownership

See [the browser service design and complete state inventory](client-service.md).

One catalog owner runs in the web SharedWorker or extension background context.
Each named library has its own identity, runtime, epoch and cancellation context. These
have separate scopes. Pages hold read-only projections and communicate through
commands/events; no page reads identity storage or receives a private key.

The master vault encrypts configuration, pending registration, upload jobs and
retained source blobs in IndexedDB. One client-wide unlock opens all libraries;
one lock clears every runtime and all client projections. The unlocked key is memory-only, so restart always locks.
Identity changes increment the owner epoch and cancel obsolete work. Authoritative
state transitions are serialized within the owner; network work does not hold a
database transaction. Durable changes publish only after transaction completion.

Internal pairing operation handles prevent forged/disposed/stale authorization.
Their implementation is private to the service and requires no cross-page locks,
storage notifications, or per-tab session generation. Shared state broadcasts
update every connected client. Reconnect/resume requests a fresh snapshot, and
uncertain mutation commands are never automatically replayed.

Accepted uploads outlive their submitting page. Owner restart marks active
transfers interrupted and pauses queued jobs, preserving their sources for
explicit retry after unlocking. Global reset discards the entire catalog and all jobs/sources; forgetting one
library removes only that library;
successful server changes discard sources for the old context. Already submitted
network requests cannot be recalled.
