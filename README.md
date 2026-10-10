# i2nclip

Encrypted media store. The browser encrypts each file in your browser before upload. The server keeps ciphertext, public keys, and tag fingerprints. It cannot read the files.

## Set up your library

Open the extension settings, use the default server (`https://clip.i2n.duckdns.org`) or enter your own URL and an invitation code from the admin, then choose an unlock password of at least 8 characters and click **Create library**. The browser generates the library identity and registers its public key automatically.

Download your **recovery file** before uploading. It contains your encrypted library identity and server URL. Keep it and remember your password: both are required to restore your library in another browser. The server cannot recover either for you. Settings also let you download the recovery file again later.

The password encrypts the identity in your Firefox profile and recovery file. It is never stored or sent to the server. Firefox asks for it once each session; the unlocked identity stays in session storage until Firefox exits. Restore accepts only i2nclip recovery files and is available when no library is configured. To switch libraries, download your recovery file, then click **Reset everything**. Reset clears the browser's saved settings and session; uploads on the server stay saved. You can then create a library or restore a recovery file.

Registration happens automatically during creation. The library identity is saved and unlocked only after registration succeeds. If registration fails, check your invitation code and try again; no reset is needed.

Admin (with `I2N_DATABASE_URL` set, or inside the running application container):

```sh
i2nclip otc issue              # prints a code (default TTL 24h)
i2nclip otc issue --ttl-secs 3600
podman exec i2nclip i2nclip otc issue
```

## Run

The process listens on `0.0.0.0:8080`. Set `I2N_ORIGIN` to the public HTTPS origin users type in the browser, with no path. Set `I2N_DATABASE_URL` to a PostgreSQL connection URL; its value is never logged. The server transactionally initializes the idempotent schema before serving. OTC issuance connects to an initialized database without running DDL.

```sh
export I2N_ORIGIN=https://clip.example.com
# Set I2N_DATABASE_URL through a private environment file or secret manager.
cargo run
```

PostgreSQL stores content, metadata, public keys, invitations, nonces, and tags. Content uses `bytea` with external TOAST storage, so ciphertext is not compressed. Uploads and metadata/tag updates commit atomically. Content is immutable and reported sizes come from the stored content. Downloads fetch owned bytes before sending responses, so deletion cannot invalidate an in-flight response and slow clients hold no database connection. The SQLx pool has eight connections, one minimum connection, and a five-second acquisition timeout (`503` with `Retry-After: 1`).

An internal maintenance task runs on startup and hourly, deleting expired nonces and invitations in one transaction. Sweeps never overlap; failures are logged and retried next interval. Shutdown stops scheduling maintenance, awaits an active sweep, drains HTTP work, and closes the pool. PostgreSQL autovacuum reclaims physical space. Response-duration limits remain future work.

## Verification

Install client dependencies with `npm ci --prefix client`, using Node from `client/.nvmrc`.

```sh
make test                 # client tests/checker and Rust tests without a database
make test-db              # testcontainers starts and cleans up PostgreSQL 18
make e2e                  # Firefox against the real Rust API
make extension
```

`make test` runs client tests/checker and Rust tests that need no database. `make test-db` uses [testcontainers](https://docs.rs/testcontainers/0.28.0/testcontainers/) to start PostgreSQL 18, wait for readiness, run the database tests, and remove the container afterward, including when tests fail. Each fixture creates and cleans up an isolated database. Testcontainers is an optional tooling dependency; ordinary builds and tests do not enable it.

For rootless Podman, enable its API socket once, then run:

```sh
systemctl --user enable --now podman.socket
make test-db
```

The target defaults `DOCKER_HOST` to the rootless Podman socket under `XDG_RUNTIME_DIR` (or `/run/user/<uid>`). Set `DOCKER_HOST` to use another Docker-compatible runtime. You do not need to start PostgreSQL yourself. Pass test filters or flags with `TEST_ARGS`, for example `make test-db TEST_ARGS="-- --nocapture"`.

If Podman's default network cannot use `/dev/net/tun`, run `I2N_TEST_CONTAINER_NETWORK=host make test-db`. This local-runtime fallback binds PostgreSQL only to `127.0.0.1` on a randomly selected port. Set `I2N_TEST_DATABASE_RESTART=1` to additionally stop/start the owned container and check persistence and reconnection through an existing SQLx pool. Restart verification requires container provisioning.

The same runner can provision PostgreSQL for Firefox:

```sh
DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock cargo run --quiet --features test-containers --example postgres-tests -- npm run e2e --prefix client
```

Use Node from `client/.nvmrc`; the host-network fallback also applies to this command.

To use an existing disposable server, set `I2N_TEST_DATABASE_URL` to an administrator URL with database-creation rights; `make test-db` will skip container provisioning. Direct `cargo test --features postgres-tests` and Firefox E2E require this explicit URL. Never point test tooling at production.

```sh
cargo test --features postgres-tests --test postgres_api maximum_size_transfer_profile -- --ignored --nocapture
```

This optional profile exercises two maximum-size uploads followed by two concurrent downloads, reports in-process peak RSS (including fixture/client buffers), PostgreSQL backend allocations, and timer delay, and verifies that responses held unpolled have no idle database transaction.

## Self-hosting

The image runs as uid 10001 and has no persistent application volume. PostgreSQL owns storage. Pass only the application owner's credentials to i2nclip, preferably with an owner-only runtime environment file:

```sh
make container
podman run --rm -p 127.0.0.1:8080:8080 --env-file app.env localhost/i2nclip
```

`app.env` contains `I2N_ORIGIN` and `I2N_DATABASE_URL`. Put HTTPS, rate limits, and abuse controls on a reverse proxy. The API lives at `/api/…` on a dedicated origin; path prefixes are unsupported. PostgreSQL must stay private, with password authentication. `sslmode=disable` is suitable only for the private same-host container network configured in i2nfra.

The i2nfra repository contains the rootless PostgreSQL 18 Quadlet, private database network, separate administrator/application credentials, health checks, and backup instructions. Its persistent named volume mounts `/var/lib/postgresql`, as required by the [official PostgreSQL 18 image](https://hub.docker.com/_/postgres). `make push` builds and copies the application image; production deployment is a separate step.

This is a fresh database transition. Existing local storage is left untouched, the new library starts empty, and administrators must issue new registration invitations. No import tool or backward compatibility is provided.

Logical backups include encrypted content:

```sh
umask 077
podman exec i2nclip-postgres pg_dump -U postgres -d i2nclip -Fc > i2nclip.dump
# Restore into an empty database owned by the existing i2nclip application role:
podman exec -i i2nclip-postgres pg_restore -U postgres -d i2nclip --role=i2nclip --no-owner --exit-on-error < i2nclip.dump
```

Stop the application before restoring. Keep encrypted inventory credentials with your recovery material; database dumps do not include PostgreSQL roles. See i2nfra's documented restore procedure. Automated backup scheduling is outside this change.

## Requests

One Ed25519 signature covers the origin, time, a one-time nonce, the method, the path, and the SHA-256 of the body. The hash is in the `Authorization` header, so the server checks the signature before it reads the body, then checks that the bytes match. A signature is good for five minutes and cannot be replayed. Each file is at most 32 MB.

Item identifiers are hashes of complete sealed content. An existing hash returns `409`, globally across owners. Different encryptions normally produce different hashes because of fresh AES-GCM nonces. A retry that re-encrypts can create another item; refresh the library after a lost response before retrying. Content URLs are immutable, while metadata and lists use `no-store`.

## Extension

All frontend code lives in `client/`, a Svelte 5 + Vite project. Build the Firefox add-on before loading it:

```sh
npm ci --prefix client
npm run build:extension --prefix client
```

In Firefox 128 or newer, open `about:debugging`, choose **Load Temporary Add-on**, and pick `client/dist/extension/manifest.json`. That directory is the complete add-on; it contains no development dependencies. `make extension` builds and packs `client/dist/i2nclip.xpi` using the system `zip` command. You can also run `npm run pack:extension --prefix client`; Python is not needed for packaging.

For development, `make dev-extension` builds the add-on, launches a development Firefox instance with `web-ext`, and automatically rebuilds and reloads the extension on source changes. `npx` downloads `web-ext` on first use. Ctrl-C stops Firefox and the build watcher. You can also run `make -C client dev-extension`. `npm run dev:extension --prefix client` runs only the build watcher, for manual reloading in an existing Firefox instance.

`npm run dev --prefix client` runs the same UI in a regular browser with a local-storage adapter. Its `/api` proxy points to `http://127.0.0.1:8080` (override with `I2N_API_TARGET`); set the backend's `I2N_ORIGIN` and the UI's server URL to `http://localhost:5173` for this mode. The standalone browser session is separate from the extension.

See the [frontend audit guide](client/README.md) for the source map, store transitions, resource ownership, and verification coverage.

The source has three boundaries:

- `client/src/lib/`: encryption, API calls, media preparation, stores, and Svelte components. No Firefox APIs.
- `client/src/extension/`: Firefox storage, tab media fetching, downloads, notifications, and context menus.
- `client/public/`: manifest, extension page shells, icons, and update metadata.

Stores own session mutations, request cancellation, pagination, and upload batches. Media stores own and release their decrypted bytes and object URLs. Settings mutations use a Web Lock across open pages; tag changes and uploads prevent overlapping submissions. The tests cover stale completions, identity changes, retry behavior, and file-size limits as well as the full browser flows.

`client/Makefile` owns the frontend targets; the root Makefile delegates with `make -C client`. `make -C client build` and `make -C client test` work independently. `make build` builds the Rust server and both frontend bundles. `make client` builds just the standalone UI and extension (`npm run build --prefix client`). `npm run e2e --prefix client` builds the extension and runs Firefox tests; `make e2e` also installs dependencies and Firefox.

The manifest's update URL now points to `client/public/updates.json`. Previously installed releases that use the old update URL need a manual update when this layout is published.

On an image, video, or audio, **Upload to i2nclip** sends it immediately, and **Upload to i2nclip with tags** opens a window for the tag list. The toolbar button opens the library.

The library lists 24 items at a time. Each card is painted from a small WebP preview stored in the encrypted metadata (JSON fields plus raw thumb bytes), made in the browser before upload. The original is downloaded when you open, play, or save it. A preview that would push the metadata past 64 KB is left off, and the file is still stored.

## Client library

`client/src/lib/index.js` exports the plain JavaScript encryption and API library. It has no Firefox or Svelte dependency. Another program can import it too:

```js
import { generatePrivateKey, registerKey, upload, list } from "./client/src/lib/index.js";
```

`generatePrivateKey()` returns `{ privateKey, publicKey }`. `privateKey` is an internal JSON identity document containing version `1`, a base64url Ed25519 seed, and its public key. Keep it secret. Register with `registerKey({ serverUrl, publicKey, otc })`; the server accepts `{ "otc": "…", "public_key": "…" }` at `POST /api/register-key`. Public keys are raw 32-byte Ed25519 keys encoded as base64url without padding. `list` returns `{ items, next }`. Pass `next` back as `after` for the following page.

## Tags

A tag is stored as `HMAC-SHA256` of the normalized word, keyed from the private key. The server can match the fingerprint. It never receives the word. The readable tags sit inside the encrypted metadata. Normalization is trim, Unicode NFC, then lowercase, so `Vacation` and `vacation` match.
