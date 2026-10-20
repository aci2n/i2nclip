# Database initialization and reset

Startup owns schema initialization through `Database::initialize`, before HTTP
requests are accepted. The baseline schema is defined in `sql/001_init.sql`.
The explicitly authorized blockchain cutover replaces this baseline directly:
libraries, device membership, immutable signed blocks, file storage lifecycle,
and hash-addressed ciphertext blobs replace the old metadata/chunk/tag tables.
There is no follow-up conversion migration or compatibility reader. Existing
databases must be recreated; editing their migration ledger cannot rebuild data.
Blob ciphertext is bounded to 16 through 4,194,368 bytes. Hashes match stored
ciphertext, published file IDs and device history are permanent, and committed
blobs can only be deleted after explicit file purge. See the
[storage specification](blockchain-storage.md) for the coordinated API/client
cutover and transaction rules.

SQLx acquires a PostgreSQL advisory lock, validates recorded checksums, and runs
pending migrations in version order. Each migration commits its SQL and history
entry transactionally. `_sqlx_migrations` persists versions and checksums, so
restarts preserve data and skip applied SQL. Concurrent starters wait for the
lock. The runner applies both the baseline and subsequent migrations. The SQL itself
uses ordinary CREATE statements and does not adopt untracked existing tables.
Chunk ciphertext storage is declared EXTERNAL directly on its column; there is no
follow-up ALTER step.

A migration error prevents startup. Transactional changes roll back on failure
or termination, which also releases the connection and lock. Future schema
changes use new numbered files, for example `sql/002_add_example.sql`; keep
applied migrations unchanged. `build.rs` watches `sql/`, and container builds
embed the SQL sources. Rebuild the server image after changing the schema.

## Reset only the application database

Stop every app instance that connects to the target database, drop that database
while connected to PostgreSQL's maintenance database, and recreate it with the
same owner. This removes application data and SQLx history together, while
preserving cluster roles and other databases. PostgreSQL refuses DROP DATABASE
when other connections remain; resolve those connections before continuing.
See the [PostgreSQL DROP DATABASE documentation](https://www.postgresql.org/docs/current/sql-dropdatabase.html).

For the remote Podman/systemd deployment, run these commands on the deployment
host after loading the newly built `localhost/i2nclip:latest` image:

```sh
systemctl --user stop i2nclip.service
podman exec i2nclip-postgres dropdb --username=postgres --maintenance-db=postgres i2nclip
podman exec i2nclip-postgres createdb --username=postgres --owner=i2nclip i2nclip
systemctl --user start i2nclip.service
```

Execute each command only after the previous command succeeds. If recreation or
startup fails, keep the application stopped and inspect the failure. Dropping
cannot be rolled back. The server initializes the fresh database automatically;
do not manually run the SQL outside SQLx or copy the old ledger. Check service
health and a successful version-1 ledger entry after startup. Reissue
invitations and use the client's reset/setup flow to create a fresh identity;
old browser identities remain stored locally but are no longer registered.

For the repository's local Compose environment, the database role is `i2nclip`:

```sh
podman compose stop server
podman compose exec -T db dropdb --username=i2nclip --maintenance-db=postgres i2nclip
podman compose exec -T db createdb --username=i2nclip --owner=i2nclip i2nclip
make dev
```

Stop any separately launched `make run` server as well. For a complete disposable
local PostgreSQL cluster reset, `podman compose down --volumes` also removes the
project's named database volume; `make dev` then recreates the cluster and app.
That broader operation resets roles and every database in that cluster. The
remote deployment uses a bind-mounted PostgreSQL directory, so named-volume
removal is not its reset procedure.

## Verification

`make test-db` uses isolated PostgreSQL databases to cover fresh/concurrent
initialization, exactly one ledger entry per migration, restart preservation, checksum
rejection, current schema bounds, owner isolation, quota transactions and
immutable content. `make lint format-check` checks static conventions, and
`make test-e2e` exercises real browser flows against fresh databases.
