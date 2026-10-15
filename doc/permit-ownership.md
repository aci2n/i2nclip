# Consolidated permit ownership

## Goal and scope
Centralize semaphore policy in src/permits.rs and replace AppState's five permit
fields with one Permits value. Keep all existing limits and HTTP behavior.
Exclude quotas, pairing attempt budgets, infrastructure limits, and client or
schema changes. No new dependencies or settings.

## Interface and ownership
Expose only construction, async upload(owner) and download(owner), and immediate
try_pairing_body(). Return owned guards or Error::Unavailable. Keep pool fields,
constants, keyed registries, and helper functions private. AppState clones share
all pools. Handlers own guards and decide their lifetime; the permits module owns
acquisition order and limits. Remove the old transfer module.

## Lifecycle and failure
Keep four global uploads, sixteen global downloads, one upload and two downloads
per key, and sixteen concurrent pairing body readers. Acquire keyed capacity
before global capacity. Waiters and guards keep keyed semaphores alive; prune
expired weak entries on admission. No persistent state or background tasks.
Cancellation releases already acquired capacity. Upload guards live through body
reading, hashing and database completion; download guards through stream EOF or
drop. Pairing remains nonblocking, after capability/attempt checks and before
body reading. Preserve authentication order, body deadlines and error mapping.

## Acceptance
Test independent keys, global saturation, keyed-first ordering, cancellation at
both admission stages, registry cleanup, and sharing across AppState clones.
Adapt media and pairing tests to the minimal interface without pool inspection;
retain body/drop/EOF, failure and timeout checks. Run Rust tests, isolated
PostgreSQL tests, formatting and warning-free Clippy. Update transfer docs and
commit the refactor atomically.
