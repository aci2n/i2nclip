# Remove the retired storage migration

## Goal and scope
Remove the unused one-time quota migration, its obsolete pre-quota fixture,
migration-only tests/helper, and execution instructions. The current initial
schema is the only supported schema. No runtime, protocol, quota, or client
changes; do not add replacement migrations or cleanup SQL.

## Interfaces, ownership and lifecycle
Delete the standalone SQL upgrade interface and its test fixture. Startup keeps
using the existing initial schema with its transaction-scoped advisory lock.
Current databases preserve media, counters and custom limits on reopening.
Retain that invariant in a test built from the current schema rather than an
upgrade. Old-schema conversion and upgrade rollback are no longer supported
behaviors; current transaction rollback and cancellation tests remain.

## Acceptance and delivery
No references to the retired script/fixture/helper or instructions for running
an upgrade remain. Initial schema is unchanged. Run formatting, all-feature
Clippy, client checks and the focused isolated PostgreSQL reinitialization test.
Commit the removal as a separate cohesive change.
