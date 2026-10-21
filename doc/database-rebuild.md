> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Fresh database baseline

## Goal and scope

Consolidate the schema into `sql/001_init.sql` for an explicitly requested full
rebuild. This one-time reset replaces the applied migration history; it overrides
the usual rule against editing applied migrations. Future schema changes still
use new numbered SQLx migrations.

Define the current MessagePack schema directly. Remove migrations 002–004,
empty-label defaults/check exceptions/catalog filtering, historical upgrade
fixtures, and pre-MessagePack size bounds. Require metadata/content of at least
42 bytes and nonempty sealed labels of 43–1024 bytes. Keep existing upper limits,
relational ownership, quota transactions, immutable content, indexes and storage.
Use ordinary CREATE statements: initialization must not silently adopt an
untracked preexisting schema.

## Interfaces and ownership

Database::initialize retains SQLx's embedded transactional runner, advisory lock,
checksum validation and migration ledger. It runs before HTTP admission. Rust
continues to validate envelopes; PostgreSQL enforces lengths and relational
invariants. No API, client, encryption, dependency or deployment workflow changes.
No runtime legacy detection, repair, backfill, or automatic reset is introduced.

## Persistence, lifecycle and failure

The operator stops application writers, drops and recreates the selected
application database, and starts a rebuilt server. The new baseline is applied
once; ordinary restarts preserve all new data. Old databases intentionally fail
checksum validation until reset. Dropping a database removes keys, invitations,
media, tags, quotas, nonces and the SQLx ledger. It cannot be rolled back. If drop
or recreation fails, keep the server stopped and report the failure; do not widen
the deletion scope. Resetting browser identity/preferences is a separate action.
The database to delete must be identified before executing destructive commands.

## Acceptance

Exactly one schema SQL file remains. Test fresh and concurrent initialization,
one ledger entry, restart preservation, checksum rejection, required bounded tag
labels, current envelope size bounds, owner isolation, quotas and immutable
content. Run Rust formatting/lint, isolated PostgreSQL tests and browser flows.
Document database-only reset commands and distinguish volume deletion, which
resets the entire dedicated development PostgreSQL cluster.
