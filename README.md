# i2nclip

Encrypted media store. The browser encrypts each file in your browser before upload. The server keeps ciphertext, public keys, and tag fingerprints. It cannot read the files.

## Set up your library

To connect another device, open Settings on an unlocked browser and choose
**Create pairing code**. On the new browser, choose **Connect existing library**,
use the same server, enter the 12-character code, and choose a password for that
device. Approve **Send library** on the original browser. The code expires after
two minutes and a failed authentication requires a fresh code. Both the web app
and Firefox extension support pairing; it gives the new device full access to
the same library without another invitation. Download a recovery file on the new
device: its recovery file uses its new password. Pairing requires HTTPS except
for loopback development servers. See [device pairing](doc/pairing.md) for the
protocol and limits.

Open the extension settings, use the default server (`https://clip.i2n.duckdns.org`) or enter your own URL and an invitation code from the admin, then choose an unlock password of at least 8 characters and click **Create library**. The browser generates the library identity and registers its public key automatically.

Download your **recovery file** before uploading. It contains your encrypted library identity and server URL. Keep it and remember your password: both are required to restore your library in another browser. The server cannot recover either for you. Settings also let you download the recovery file again later.

The password encrypts the identity in your Firefox profile and recovery file. It is never stored or sent to the server. Firefox asks for it once each session; the unlocked identity stays in session storage until Firefox exits. Restore accepts only i2nclip recovery files and is available when no library is configured. To switch libraries, download your recovery file, then click **Reset everything**. Reset clears the browser's saved settings and session; uploads on the server stay saved. You can then create a library or restore a recovery file.

Reset also invalidates unlocked web sessions in other tabs. Restoring the same
library does not unlock those tabs; enter the password in each tab again. Existing
unlocked sessions from before this change require one password entry after
upgrading. Saved identities and recovery files remain compatible.

Registration happens automatically during creation. The encrypted identity is saved before sending the request, but the library becomes available only after registration is confirmed. If registration fails, keep the original password and retry; the pending creation survives closing the page. A signed check detects a registration whose response was lost, so retrying does not require another invitation. If your code was rejected, enter a valid code and retry with the same password. Discarding a pending creation requires confirmation because its invitation may already have been spent.

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

For local development with Linux Podman, run `make dev`. It builds the existing
server image (including the web client), starts PostgreSQL 18, and serves the app
at `http://localhost:8080`. Rust, Node, and npm run inside the image build; only
Podman is required on the host. Rerun `make dev` after source changes to rebuild.

The server and database share the `i2nclip-dev` bridge network. Only the server
publishes a port, bound to host loopback; PostgreSQL has no host port. Image builds
use `CONTAINER_NETWORK=host` by default, independently of the runtime network.
Runtime requires working Podman bridge networking. If rootless Pasta reports a
missing `/dev/net/tun`, fix the host's rootless networking configuration; changing
the build network does not fix container startup.
The database uses fixed development-only credentials and persists in the named
`i2nclip-dev-postgres-data` volume mounted at `/var/lib/postgresql`.

```sh
make dev                         # attached server logs; Ctrl-C stops the server
make dev-otc                     # in another terminal, issue a registration code
make dev-down                    # stop both containers, preserving database data
make dev DEV_PORT=8081           # app origin defaults to http://localhost:8081
```

`make dev-db` starts only the database and waits for an authenticated TCP query
to succeed. `DEV_ORIGIN` overrides the server's expected browser origin, for
example `make dev DEV_ORIGIN=http://localhost:5173` when using Vite separately.
The database stays running after Ctrl-C or a server failure. Database startup
has a 60-second readiness limit; failure prints database logs and prevents server
startup. `make run` still runs Rust directly with your own environment settings.

When schema changes require a fresh development database, explicitly delete its
container and volume (this destroys all local development data), then restart:

```sh
make dev-down
podman rm i2nclip-dev-postgres
podman volume rm i2nclip-dev-postgres-data
make dev
```

PostgreSQL stores content, metadata, public keys, invitations, nonces, and tags. Content uses `bytea` with external TOAST storage, so ciphertext is not compressed. Uploads and metadata/tag updates commit atomically. Content is immutable and reported sizes come from the stored content. Downloads fetch owned bytes before sending responses, so deletion cannot invalidate an in-flight response and slow clients hold no database connection. The SQLx pool has eight connections, one minimum connection, and a five-second acquisition timeout (`503` with `Retry-After: 1`).

An internal maintenance task runs on startup and hourly, deleting expired nonces and invitations in one transaction. Sweeps never overlap; failures are logged and retried next interval. Shutdown stops scheduling maintenance, awaits an active sweep, drains HTTP work, and closes the pool. PostgreSQL autovacuum reclaims physical space. Response-duration limits remain future work.

For authentication troubleshooting, temporarily set `RUST_LOG=i2nclip::auth=debug` in the app container's Quadlet and restart it, then inspect `podman logs i2nclip`. Rejections log a reason and request method/path; timestamp failures also log client/server time and skew. Logs omit authorization headers, keys, signatures, nonces, and query strings. Remove the setting when troubleshooting is complete.

## Verification

Install client dependencies with `npm ci --prefix client`, using Node from `client/.nvmrc`.

The root Makefile groups verification commands by required access:

| Access | Targets | Requirements |
| --- | --- | --- |
| Local processes and files | `test`, `test-client`, `lint`, `format-check`, `test-packages` | Installed toolchains and client dependencies; package checks also need zip, unzip, and GNU tar |
| Local database/container | `test-db` | Disposable PostgreSQL administrator connection, or Docker/Podman API access to provision one; image pulls may use the network |
| Linux process profile | `test-profile` | Local Podman, Linux process counters, and port 8080 free; always provisions its own PostgreSQL container |
| Browser and local servers/database | `test-e2e` | Firefox launch, loopback HTTP/TCP, and Docker/Podman or a disposable administrator URL; also installs dependencies and Firefox |
| External network, read-only | `audit` | Installed cargo-audit and access to vulnerability advisories |
| External network, deployment writes | `test-smoke` | Private test credentials; creates an identity and uploads, edits, and deletes test media |

`make test-packages` builds all three client archives and checks their contents
and the extracted CLI. Local checks need no running database or browser; initial
toolchain/dependency downloads still require network access. `make test-e2e`
provisions PostgreSQL through the same runner as `test-db`;
provide `I2N_TEST_DATABASE_URL` to use an existing disposable administrator connection.

`make test-all` runs every test suite sequentially, including package checks,
the Linux maximum-size transfer profile, Firefox tests, and
the live smoke test. It also runs lint and formatting checks. Rust tests execute once through
`test-db`; standalone `make test` still runs Rust and client checks. Configure the
private smoke credentials first. `client-test`, `e2e`, and `smoketest` remain
aliases for `test-client`, `test-e2e`, and `test-smoke`. The optional advisory
check `make audit` remains separate.

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

For separate release-server, Node-client, and PostgreSQL process measurements, see [the process profile](doc/postgresql-profile.md). `make test-profile` also checks chunked uploads and held downloads.

## Web client in the server image

`make container` builds the web client in a Node 22.23.3 stage and copies only
its static HTML/JS/CSS into the final Rust server image. Rust serves the web
client at `/` and its assets at `/assets/`, alongside the existing `/api/` routes.
The image runs one process as uid 10001; Node and npm are absent at runtime.
The image has no built-in health check; deployment monitoring can check
`/api/health` and the web entry page at `/`.

`I2N_WEB_DIR` selects the directory of built web files. The image sets it to
`/usr/local/share/i2nclip/web`; source execution defaults to `client/dist/web`
relative to the working directory. Run `npm run build:web --prefix client`
before `cargo run` to serve the built client locally, then select that server
origin in Settings. Missing local web files return 404 while the API stays usable.
HTML revalidates on each use; generated hashed assets are cached immutably.
Unknown API paths and missing assets return 404 instead of an HTML fallback.

In i2nfra, the existing Caddy proxy and i2nclip Quadlet serve both API and UI at
`https://clip.i2n.duckdns.org`. No extra container, network, or CORS setup is needed.
The web browser session is separate from the extension; restore the same recovery
file to access its library. Build/push updates both API and UI together. See
`i2nfra/I2NCLIP.md` for image backup, explicit service restart, health checks,
and rollback; `make push` alone does not restart the running service.

## Self-hosting

The image runs as uid 10001 and has no persistent application volume. PostgreSQL owns storage. Pass only the application owner's credentials to i2nclip. In Quadlet, set `I2N_ORIGIN` with `Environment=` and mount a Podman secret at a file path provided by `I2N_DATABASE_URL_FILE`. `I2N_DATABASE_URL` remains available for local development. `make container` builds the image. Put HTTPS, rate limits, and abuse controls on a reverse proxy. The API lives at `/api/…` on a dedicated origin; path prefixes are unsupported. PostgreSQL must stay private, with password authentication. `sslmode=disable` is suitable only for the private same-host container network configured in i2nfra.

The i2nfra repository contains the rootless PostgreSQL 18 Quadlet, private database network, separate administrator/application credentials, health checks, and backup instructions. It stores PostgreSQL data in `~/.local/share/i2nclip/postgres`, bind-mounted at `/var/lib/postgresql` as required by the [official PostgreSQL 18 image](https://hub.docker.com/_/postgres). `make push` builds and copies the application image; production deployment is a separate step.

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

In Firefox 157.0.1 or newer, open `about:debugging`, choose **Load Temporary Add-on**, and pick `client/dist/extension/manifest.json`. That directory is the complete add-on; it contains no development dependencies. `make extension` builds and packs `client/dist/i2nclip.xpi` using the system `zip` command. You can also run `npm run pack:extension --prefix client`; Python is not needed for packaging.

For development, `make dev-extension` builds the add-on, launches a development Firefox instance with the locally installed `web-ext`, and automatically rebuilds and reloads the extension on source changes. Run `npm ci --prefix client` once to install development dependencies; startup uses the pinned local executable without downloading it. Ctrl-C stops Firefox and the build watcher. You can also run `make -C client dev-extension`. `npm run dev:extension --prefix client` runs only the build watcher, for manual reloading in an existing Firefox instance.

`npm run dev --prefix client` runs the same UI in a regular browser with a local-storage adapter. Its `/api` proxy points to `http://127.0.0.1:8080` (override with `I2N_API_TARGET`); set the backend's `I2N_ORIGIN` and the UI's server URL to `http://localhost:5173` for this mode. The standalone browser session is separate from the extension.

See the [frontend audit guide](client/README.md) for the source map, store transitions, resource ownership, and verification coverage.

The source has three boundaries:

- `client/src/lib/`: encryption, API calls, media preparation, stores, and Svelte components. No Firefox APIs.
- `client/src/extension/`: Firefox storage, tab media fetching, downloads, notifications, and context menus.
- `client/public/`: manifest, extension page shells, icons, and update metadata.

Stores own session mutations, request cancellation, pagination, and upload batches. Media stores own and release their decrypted bytes and object URLs. Settings mutations use a Web Lock across open pages; tag changes and uploads prevent overlapping submissions. The tests cover stale completions, identity changes, retry behavior, and file-size limits as well as the full browser flows.

`client/Makefile` owns the frontend targets; the root Makefile delegates with `make -C client`. `make -C client build` and `make -C client test` work independently. `make build` builds the Rust server and all three client bundles. `make client` builds just the standalone UI, extension, and Node CLI (`npm run build --prefix client`). `npm run e2e --prefix client` builds the extension and runs Firefox tests; `make e2e` also installs dependencies and Firefox.

The manifest's update URL now points to `client/public/updates.json`. Previously installed releases that use the old update URL need a manual update when this layout is published.

On an image, video, or audio, **Upload to i2nclip** sends it immediately, and **Upload to i2nclip with tags** opens a window for the tag list. Every context-menu upload keeps its own pending source until it succeeds. If an immediate upload fails, a popup shows the error and lets you retry explicitly. Pending sources stay in browser session storage until success, reset, or browser exit. The toolbar button opens the library.

The library lists 24 items at a time. Each card is painted from a small WebP preview stored in the encrypted metadata (JSON fields plus raw thumb bytes), made in the browser before upload. The original is downloaded when you open, play, or save it. A preview that would push the metadata past 64 KB is left off, and the file is still stored.

## Client library

`client/src/lib/index.js` exports the plain JavaScript encryption and API library. It has no Firefox or Svelte dependency. Another program can import it too:

```js
import { generatePrivateKey, registerKey, upload, list } from "./client/src/lib/index.js";
```

`generatePrivateKey()` returns `{ privateKey, publicKey }`. `privateKey` is an internal JSON identity document containing version `1`, a base64url Ed25519 seed, and its public key. Keep it secret. Register with `registerKey({ serverUrl, publicKey, otc })`; the server accepts `{ "otc": "…", "public_key": "…" }` at `POST /api/register-key`. Public keys are raw 32-byte Ed25519 keys encoded as base64url without padding. `list` returns `{ items, next }`. Pass `next` back as `after` for the following page.

## Tags

A tag is stored as `HMAC-SHA256` of the normalized word, keyed from the private key. The server can match the fingerprint. It never receives the word. The readable tags sit inside the encrypted metadata. Normalization is trim, Unicode NFC, then lowercase, so `Vacation` and `vacation` match.

## Live deployment smoke test

After deploying, run `make test-smoke` against the public server
(`https://clip.i2n.duckdns.org`). It uses the Node version in `client/.nvmrc` and
needs no frontend build or installed npm dependencies. Override the executable
with `NODE=/path/to/node` when needed.

Put the testing invitation in `~/.config/i2nclip/smoke/otc` and its password in
`~/.config/i2nclip/smoke/pw`; use private files with mode 0600. The password must have at
least eight characters. These credentials and the encrypted `recovery.json` stay
outside the checkout. The first run saves an encrypted recovery file before registration and
consumes the invitation. Subsequent runs reuse that identity and check its
registration without spending another code. Keep the recovery file and original
password when retrying a failed registration.

```sh
make test-smoke
make test-smoke SMOKE_SERVER=https://clip.example.com SMOKE_DIR=/private/test-credentials
```

An existing recovery file must match the selected server origin. Use a separate
credential directory for another deployment. `SMOKE_DIR` defaults to
`~/.config/i2nclip/smoke` and must already contain `otc` and `pw`; it is independent of the
normal CLI's XDG recovery location.

The test uploads random 1 KiB, 1 MiB, and 32 MiB files individually, checks
metadata and tag searches, verifies downloaded bytes, exercises tag replacement
and normalized add/remove, deletes its files, and checks that deleted metadata
returns HTTP 404. Expect approximately 66 MiB of upload/download traffic per run.
It exercises the dedicated GET/PUT metadata routes and fails against a server
that has not deployed them.

Node connection attempts allow one second before trying another address family.
Each command has a 120-second timeout. Ctrl-C cancels the active request and
starts cleanup with an independent 30-second budget. Cleanup deletes only IDs
created by this run or found under its unique run tag, including uploads whose
response was lost. Local temporary files are removed; the encrypted recovery
file is retained. A failed cleanup causes a nonzero exit and reports known
remaining IDs or the run tag to inspect. Passwords, invitations, keys, and file
contents are never printed.

## Client packages

After installing dependencies with `npm ci --prefix client` using the Node version
in `client/.nvmrc`, run `make packages` to create all three distributables.
`make web`, `make extension`, and `make cli` build and package individual targets.
These commands also work directly with `make -C client`.

| Target | Build directory | Archive |
| --- | --- | --- |
| Web | `client/dist/web/` | `client/dist/i2nclip-web.zip` |
| Firefox extension | `client/dist/extension/` | `client/dist/i2nclip.xpi` |
| Node CLI | `client/dist/cli/` | `client/dist/i2nclip-cli.tar.gz` |

The web ZIP contains `index.html` and its JavaScript/CSS assets at the archive
root. Extract it into the root of a static HTTPS site. Build assets use absolute
`/assets/` URLs, so hosting under a path prefix is unsupported. The Vite development
API proxy is not included: production hosting must route `/api/` to the Rust API
on the configured origin, or use an API server that permits the browser origin.

The CLI archive contains `i2nclip-cli/i2nclip.mjs`. It requires Node 22.23.3 or
newer and no npm installation or repository files:

```sh
tar -xzf client/dist/i2nclip-cli.tar.gz
./i2nclip-cli/i2nclip.mjs --help
# Alternatively: node i2nclip-cli/i2nclip.mjs --help
```

Packages contain only their runtime files. Extension update metadata remains in
`client/public/updates.json` and is not copied into the build or XPI. Each build
cleans its own directory, and each archive is recreated to remove stale entries.
JavaScript and CSS remain unminified. Packaging uses system `zip` and GNU `tar`.
Run `make test-packages` to build the archives and check their contents and the
extracted CLI. Browser E2E tests also package the CLI and exercise
that extracted executable against the real API.
