# Database migrations

Startup owns schema initialization through `Database::initialize`, before HTTP
requests are accepted. It runs SQLx migrations embedded from `sql/`; no runtime
SQL directory or separate migration service is required. `001_init.sql` is the
first migration, unchanged from the initial schema.

SQLx acquires a PostgreSQL advisory lock, validates recorded checksums, and runs
pending migrations in version order. Each ordinary PostgreSQL migration commits
its SQL and history entry transactionally. `_sqlx_migrations` persists versions
and checksums, so restarts skip applied SQL. Concurrent server starters wait for
the migration lock. This lock does not pause already running servers.

A migration error prevents startup. Failed transactional changes roll back;
previously committed migrations remain applied. Process termination releases the
connection and its lock, and PostgreSQL rolls back an unfinished transaction.
There is no custom cancellation workflow or automatic downgrade.

Add future schema changes as numbered files, for example
`sql/002_add_example.sql`. Never edit or delete an applied migration. Rebuild and
deploy the server to run new migrations automatically. `build.rs` watches `sql/`
for added files; the container build includes that build script and SQL sources.

This infrastructure introduces no schema changes, quota backfills, legacy-schema
conversion, CLI commands, or client changes. A database initialized outside SQLx
receives migration 001 and its history entry on its next startup; it must already
match the current schema. The initial SQL uses `IF NOT EXISTS` but does not
validate or repair older schemas.

Acceptance checks use isolated PostgreSQL databases: concurrent initialization
succeeds, migration 001 is recorded once, subsequent initialization preserves data
and skips its SQL, and a changed recorded checksum rejects initialization. Run
`make test-db` for database coverage, `cargo test` for ordinary Rust tests, and
`make lint format-check` for static checks.
