# Per-key storage limits

## Goal, scope, and interfaces

Bound each registered key to 536,870,912 encrypted-content bytes (512 MiB) and
10,000 files by default. Administrators may override these through
`otc issue [--ttl-secs N] [--max-bytes N] [--max-files N]`, or change an existing
key with `key set-limits PUBLIC_KEY --max-bytes N --max-files N` (both required).
Limits are nonnegative signed BIGINT decimal integers; zero blocks uploads.
Unknown keys fail. Registration transfers invitation limits only to new keys;
an already registered key retains its limits. Paired devices share the key.

The database owns quota enforcement and persistence. The CLI owns argument
parsing; existing database credentials apply. HTTP uploads exceeding a limit
return 409 with `Library storage limit reached.`. Existing duplicate-content
conflicts retain their behavior. No client changes, admin API/UI,
background jobs, physical-disk accounting, or schema-version table.
The CLI uses clap derive for command definitions, typed numeric ranges, defaults,
required options, duplicate/unknown argument errors, and generated help. Running
without a subcommand still starts the server. Help exits successfully without
reading database configuration; malformed arguments exit with status 2. Native
clap numeric syntax and `--option=value` are accepted. Argument parsing owns no
persistence or asynchronous resources; database workflows remain unchanged.

## Persistence and startup

Keep `registered_keys` key-only. Store limits and nonnegative BIGINT counters
`used_content_bytes` and `file_count` in `key_quotas`, keyed by and referencing
`registered_keys.public_key`. Invitations retain their chosen limits. Registration
creates the quota row in the same transaction, preserving existing limits/usage
on re-registration. Limits default to 512 MiB and 10,000 files; counters start at
zero. Database CHECK constraints require used_content_bytes <= max_content_bytes
and file_count <= max_files. Limit changes below usage fail without changing
limits, counters, or files. Exact equality is valid.

Retain generated `files.content_bytes` for metadata projections and delete
accounting. Remove the unused covering-index creation from the draft schema.
There are no per-upload SUM/COUNT queries or accounting triggers. Database
methods are the media writers and own counter maintenance.

The migration targets the committed pre-quota schema, not intermediate unpublished
drafts. It is a standalone, one-time SQL script, never executed at startup. Run it
with `psql --single-transaction -v ON_ERROR_STOP=1 --file sql/002_storage_limits.sql`
after stopping old servers and backing up the database. The script takes the
existing advisory lock and upgrades the schema, then seeds missing quota rows
from existing files. For existing libraries over defaults, raise initial limits
to current usage so data is preserved and the CHECK constraints hold. Existing
quota rows are not changed on repeat manual execution. Failures roll back the
transaction. Fresh databases use the current initial schema; restarts run no
backfill or media SUM/COUNT queries. No version table or runtime fallback.

Backfilling generated sizes and initial usage may take time and disk space.
Logical quotas exclude PostgreSQL indexes, WAL, and dead tuples; leave disk
headroom. Startup does not apply data migrations.

## Upload lifecycle and failures

Uploads lock the owner's quota row, retain duplicate-content conflict behavior,
and conditionally reserve bytes plus one file before insertion. Use subtraction
in the byte-limit predicate to avoid BIGINT overflow; exact limits are allowed.
Keep the quota lock through commit. Deletes take the same lock first, delete only
an owned file with RETURNING content_bytes, and decrement both counters before
commit. Missing or foreign deletes change no usage. Metadata edits do not touch
counters. This consistent quota-before-file lock order coordinates concurrent
uploads, deletes, and administrator updates across processes.

Failed writes, conflicts, and cancellation roll back counters and media together.
No counters are charged until the entire transaction commits. Metadata edits,
reads, and deletes remain available at the quota limit. Quota rows are locked
before file rows for every media mutation.

## Acceptance checks

Test defaults/custom limits, invitation inheritance and re-registration,
administrator updates and CLI validation, zero/exact/exceeded limits, independent
owners, duplicate/foreign/repeated deletion, lowering limits, concurrent uploads
and deletes, and cancellation/rollback. Assert counters equal actual stored bytes
and file count after successful and failed mutations and repeated startup.
Use isolated PostgreSQL databases to verify migration from the previous schema,
data preservation, exact usage backfill, lean authorization table, startup rollback and
concurrent/repeated initialization without resetting configured limits. Test both
CHECK constraints, rejection of reductions below usage, and one-time migration
of libraries above the defaults. Run
formatting, warning-free builds, standard and PostgreSQL tests. Verify generated
help, numeric ranges, required flags, and no-argument server startup. Leave all
changes in a cohesive commit after verification, as authorized by the user.
