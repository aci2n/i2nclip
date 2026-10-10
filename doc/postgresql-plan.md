# Move i2nclip to PostgreSQL-backed content storage

This plan records the agreed implementation scope. It is not a claim that every acceptance check has passed. Subsequent decisions keep `make test` database-free and use testcontainers for the separate `make test-db` target. Production deployment remains a separate step.

## Summary

Replace SQLite and filesystem blobs with PostgreSQL `bytea` storage and a dedicated async database layer. Content, metadata, and tags commit atomically. Remove application connection mutexes, filesystem journals, and the blocking-work helper.

Use a fresh database, preserve the current protocol and crypto format, and keep the flat Rust source directory. Add a rootless PostgreSQL container in i2nfra.

## Application and database design

- Add `db.rs` containing a concrete `Database` type backed by SQLx's async PostgreSQL pool. All SQL, transactions, row decoding, and database-error classification belong here; handlers and authentication call named database operations. Do not add repository traits or generic transaction frameworks.
- Separate shared application state from persistence. State contains `Database`, the public origin, and the existing two-upload/two-download semaphores.
- Require `I2N_DATABASE_URL_FILE` for the deployed container and keep `I2N_DATABASE_URL` available for local development; never log either value. Use eight pool connections, one minimum connection, and a five-second acquisition timeout. Return a generic `503` with `Retry-After: 1` for pool acquisition timeouts.
- Make router construction and OTC issuance async. Remove filesystem parameters, `DATA_DIR`, and the OTC `--data-dir` option. OTC reads the same connection environment variable as the server.
- Replace the initial schema directly. Keep registrations, invitation codes, nonces, files, and tags. Add immutable `content BYTEA NOT NULL` to `files`; remove `staged_files`. Use `STORAGE EXTERNAL` for content to avoid compressing ciphertext.
- Preserve lowercase SHA-256 text identifiers, owner keys, integer timestamps, tag uniqueness, and existing pagination indexes. Enforce sealed-content and metadata length bounds in SQL; derive reported content size from stored content rather than maintaining an independently mutable size.
- Apply the idempotent initial schema transactionally before starting the server. OTC connects to an initialized database without running DDL. Tests initialize isolated databases before use. Do not add migration versions or SQLite import tooling.

Database operations:

- Upload inserts content, metadata, and tags in one transaction. A conflict on the file identifier returns `409`, including across owners. Other constraint failures remain database errors.
- Metadata updates lock/update the authorized file and replace its tags in one transaction.
- Deletion removes the authorized file; cascading foreign keys remove tags. No separate content cleanup is necessary.
- Listing fetches metadata and tags from one SQL statement, preserving owner filtering, AND tag matching, ordering, and cursor semantics. Content is never selected by list queries.
- Download selects the authorized complete content value in one statement. Once fetched, release the connection and send the owned bytes; concurrent deletion cannot invalidate that response.
- Invitation consumption and key registration remain one atomic transaction. Concurrent consumption permits only one success.
- Authentication retains the cheap initial timestamp check. After signature verification, reserve the nonce through the database layer, then recheck the timestamp **after the awaited insertion finishes**, before reading the body. This covers pool and database waits without making the database layer call authentication policy. An expired request can leave a spent nonce but cannot execute its endpoint.

## Resource ownership and maintenance

- Keep transfer admission and existing body caps/deadlines. Acquire download admission before fetching content and hold it through response completion, error, or cancellation.
- Accept full-buffer downloads. Avoid unnecessary content copies when constructing responses; profile SQLx's encoding/decoding overhead rather than assuming only one allocation.
- Remove filesystem operations and `spawn_blocking` from the application. Hash request bytes and sealed content incrementally in at most 64 KiB pieces, yielding between pieces. Preserve exact signed bytes and current hash results.
- Replace GC with an internal async maintenance task: run once after startup and hourly thereafter, skip missed ticks, and never overlap sweeps.
- Delete expired nonces using `expires < now` and expired registration codes using `expires_at <= now`. Perform both deletions in one short transaction and log their counts.
- Maintenance does not acquire upload permits. Failures are logged and retried at the next interval; they do not stop the server.
- On shutdown, stop scheduling maintenance, await an active sweep, drain HTTP work, and close the pool. PostgreSQL autovacuum handles physical space reclamation.
- Remove SIGUSR1 handling, the staged-file age policy, filesystem fault tests, and obsolete storage documentation. Update the priority list to mark superseded SQLite/file work and retain applicable Rust cleanup and download-timeout work.

## i2nfra deployment

- Add `i2nclip-postgres.container` using the official `postgres:18` image, pinned to its major version, with `AutoUpdate=registry` for minor updates. PostgreSQL 18 stores its versioned data under `/var/lib/postgresql`; the deployment bind-mounts `~/.local/share/i2nclip/postgres` there. See the [official image documentation](https://hub.docker.com/_/postgres).
- Add `i2nclip-db.network`. Only PostgreSQL and i2nclip join it; i2nclip also retains its existing Caddy-facing network. Do not publish PostgreSQL's port or connect Caddy to the database network.
- Use container name/DNS alias `i2nclip-postgres`. Add PostgreSQL service ordering and dependency to i2nclip; startup connection failures cause a clear error and systemd restart.
- Initialize database `i2nclip` with a separate nonsuperuser application owner. Keep bootstrap administrator credentials separate; the application receives only its own credentials.
- Generate two random credentials locally and store them through the existing Privy encrypted-inventory workflow. Provision them as Podman secrets, suppress secret-bearing operation output, and percent-encode credentials when building the connection URL.
- Mount the PostgreSQL bootstrap password as a secret and use `POSTGRES_PASSWORD_FILE`. Mount the application URL as a secret and pass its path through `I2N_DATABASE_URL_FILE`; TLS is disabled explicitly for this private same-host container network. Require SCRAM authentication; do not enable trust authentication for network connections.
- Configure PostgreSQL with `max_connections=30`, `shared_buffers=128MB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, and `max_wal_size=1GB`. Keep autovacuum, `fsync`, `full_page_writes`, and `synchronous_commit` enabled. Set application-role statement timeout to 30 seconds and idle-in-transaction timeout to 60 seconds.
- Add a PostgreSQL health check using `pg_isready`; extend host health checks to include the database service/container.
- Remove the app's data-volume mount and storage-specific user mapping. Remove its image volume declaration and storage-directory assumptions.
- Disable and stop the existing GC timer, remove its timer/service files, and reload user systemd. Update deploy instructions and health checks accordingly.
- Leave old SQLite/blob storage untouched. Document that the new library starts empty and requires new registration invitations.
- Provide documented logical backup and restore commands using `pg_dump`/`pg_restore`, including content. Automated backup scheduling remains outside this change.
- Prepare and validate both repositories locally; do not deploy to the VPS during implementation.

## Verification and acceptance

- Separate tests that require PostgreSQL from tests that do not. `make test` runs client tests, the Svelte checker, and Rust tests without a database.
- `make test-db` uses testcontainers to provision PostgreSQL 18, wait for readiness, run PostgreSQL tests, and clean up the container even when tests fail. Rootless Podman uses its Docker-compatible API socket. Keep testcontainers optional so ordinary application builds and tests do not enable it.
- Allow `I2N_TEST_DATABASE_URL` to override provisioning with an existing disposable server. Direct PostgreSQL test commands require this explicit URL and fail clearly if PostgreSQL is unavailable. Every test fixture initializes and cleans up an isolated database.
- Update Firefox fixtures to provision/clean isolated databases, pass connection URLs through environment variables, and replace SQLite-specific setup/inspection. Firefox E2E requires an explicit test connection URL.
- Verify atomic rollback for failed uploads and metadata updates; duplicate uploads across independent app instances; owner isolation; invitation races; nonce replay and timestamp boundaries; maintenance expiration boundaries and rollback.
- Preserve protocol/crypto vectors, body-limit/deadline tests, transfer saturation, and cancellation tests. Replace filesystem-pinning tests with downloads remaining readable after concurrent database deletion.
- Test pool acquisition timeout, database restart/reconnection, missing configuration, and maintenance failure recovery.
- Measure maximum-size uploads/downloads, including two simultaneous transfers in each direction. Record app peak memory, PostgreSQL resource use, and event-loop responsiveness; ensure no connection remains checked out while an HTTP response is draining. Distinguish test-client allocations from application-process memory.
- Run `make test`, `make test-db`, Firefox E2E tests, `make extension`, formatting, and available lint checks. Validate i2nfra templates, Python checks, Quadlet generation, and deployment dry run.
- Completion requires no SQLite dependency, filesystem blob storage, application connection mutex, staged-file journal, SIGUSR1 GC handler, or application `spawn_blocking` calls.
- Keep new code consistent with existing project patterns: readable multiline SQL, explicit column lists, normal indentation and spacing, and expanded async workflows/test setup.

## Assumptions

Fresh database; no data import or backward compatibility. Full `bytea` downloads are accepted. Maintenance is internal and hourly. Credentials follow encrypted inventory conventions. PostgreSQL remains private to the host's container network, and production deployment is a separate step.

Implementation status and remaining checks are tracked in [priorities.md](priorities.md).
