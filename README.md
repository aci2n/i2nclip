# i2nclip

An encrypted media library with a client-verified, signed append-only history.
The server stores ciphertext and public authorization/storage effects; filenames,
tags, thumbnails, manifests, and file contents are encrypted by the browser.

## Set up a library

Create a local master password, then enter an administrator invitation and choose
**Continue**. Download the generated library backup and store its password
securely and separately; both are required to restore. **Create library** stays
disabled until the download starts and you confirm the backup is stored. The
server defaults to the app's origin, with configuration in a disclosure.

One shared library seed grants full authority. Every connected browser holds it,
sealed under that browser's master password. Connect another browser with
**Settings → Connect another browser**: compare both verification codes and
approve; the transfer carries the seed and a trusted history checkpoint. If no
connected browser remains, **Restore** uses the backup file and password. There
is no revocation or rotation: a lost browser that holds the seed keeps full
authority, so protect each browser with a strong master password.

Each browser tab loads its sealed credential once from IndexedDB. **Remember this
device** is optional; Lock ends that tab's resources and clears its remembered
unlock key. Other open tabs retain their loaded access. There are no cross-tab
notifications, polling, or locks. **Forget this browser** removes the local
credential and its history cache; **Reset this client** removes local credentials
and all history caches. These actions remove local rollback protection but leave
server data intact. There are no legacy format readers or migrations.

## Browse, edit, and recover history

The client verifies signatures, authority transitions, encryption, and hash links
before applying operations. It stores encrypted records and its latest trusted
head in IndexedDB, while materialized state and search indexes stay in memory.
An incomplete metadata index is reported explicitly rather than as no matches.
Search files locally by filename or tag. Uploads and lifecycle changes apply to
the current head even when other blocks landed meanwhile; a metadata edit made
from an outdated revision of the same file requires explicit review and retry.

Open **Earlier versions** to browse read-only history. The UI is a projection of
that selected materialized state. **Back to current** returns to the live state.
Upload, metadata edits, deletion, and other file writes are disabled in
historical views. Current quota remains operational state and does not rewind.

Delete moves a file to **Deleted files**, where it can be restored. **Permanently
delete** appends an explicit purge and removes all retained content, metadata,
and thumbnail versions. Purged data is unavailable even in historical views.
Deletion alone does not free storage. The encrypted operation history remains;
plaintext metadata and file bytes are stored separately so they can be purged.

Uploads run sequentially, continue after individual failures, and survive view
navigation. Select failed files again to retry. Files use random IDs and content
keys; an immutable encrypted manifest lists explicit ciphertext hashes in chunk
order. Mutable metadata stores the thumbnail reference. Content is encrypted in
4 MiB slices, each fully authenticated before exposing plaintext. Native media
previews and downloads use a service worker on the app origin; the owning tab
must remain open and unlocked. Plaintext is not saved in application caches.

Compression preferences remain local. Supported images up to 32 MiB compress to
WebP only when smaller; large files skip image compression and image/audio
thumbnail extraction. Native video thumbnails have a bounded decoder deadline.
Uploads add ordinary editable automatic tags. Filename and tag edits are inline;
failed saves retain their draft. Preview text is escaped and bounded to 256 KiB.

The root workspace owns uploads, downloads, quota, and verification across
Library/Settings navigation. Private `#/media/<id>` links contain no keys and
require a connected browser. The default deployment serves the client and API on
the same domain.

## Firefox extension

Run `make extension` (Node from `client/.nvmrc` is required). The unpacked
extension is in `client/dist/extension/`. In Firefox, open `about:debugging`, choose
**This Firefox → Load Temporary Add-on**, and select the generated `manifest.json`.
Temporary add-ons are removed on browser restart; permanent installation requires
Mozilla signing. In `about:addons`, select **Upload to i2nclip**, open **Preferences**,
and save the URL you use to open i2nclip.
Use HTTPS, or HTTP loopback during development, and allow the requested website
access for the app and media sources.

Right-click an image, audio, or video and choose **Upload to i2nclip**. The extension
uses your existing app tab without changing focus while unlocked. It focuses the
app only when unlocking is needed. If no app tab exists, it opens a regular tab
that stays open for future uploads. Keep it open and unlocked to avoid entering
your password for each upload. A locked app holds one file invisibly and uploads it automatically after unlock. Firefox shows
a notification when the upload succeeds or fails.
Capture names use media alt/title/aria-label text, then the page title or URL,
with an appropriate file extension. Captures also keep the source page URL and
title in encrypted metadata; open **File details → Source** to revisit the page.
Set up the library before capturing. Only public HTTP(S) media up to 32 MB is
supported; protected media and blob URLs need manual Upload.

The extension stores only the app URL. Encryption, identity, progress, and errors
remain in the web app. Pending files exist only in memory and disappear on reload,
tab close, or identity/session changes. If a handoff fails without a reply,
check the app before retrying. See the [scope and ownership specification](doc/extension-bridge.md).

## Administration and storage

```sh
i2nclip otc issue
i2nclip otc issue --ttl-secs 3600
i2nclip otc issue --max-bytes 2147483648 --max-files 20000
i2nclip key set-limits PUBLIC_KEY --max-bytes 536870912 --max-files 10000
```

Libraries default to 512 MiB of encrypted blob storage and 10,000 retained files.
Limits and counters belong to the library, shared by its browsers. Quota includes
staging and retained deleted files; purge or expired staging releases capacity.
Block-history bytes are reported separately. Lowering limits below current usage
is rejected. Leave disk headroom for block history, indexes, WAL, and dead tuples.

The server bounds transfers to one upload and two downloads per library key, with
global limits of four uploads and sixteen downloads. Downloads release database
connections before sending owned ciphertext. Staged uploads expire after 24 idle
hours; committed files are never automatically collected. Startup runs embedded
SQLx migrations from `sql/001_init.sql`. This is a fresh-database baseline; drop
pre-redesign databases. Keep applied migrations unchanged for future schema work.

The authoritative design is in the [protocol](doc/protocol.md), including its
threat model. The server is untrusted for content and freshness: local pins
detect rollback, and pairing supplies a trusted head to new browsers. A server can still deny service or withhold data. Same-origin client
code delivery remains part of the trust boundary.

## Build and run

Use Node from `client/.nvmrc` and an installed Rust toolchain:

```sh
make build              # prepares locked client dependencies
```

Clients can also be hosted on another domain: the API allows cross-origin requests using signed Authorization headers. Set the client’s server URL to the API origin.

The server listens on port 8080 and serves the built web client alongside `/api/`. Set `I2N_ORIGIN` to the public origin with no path, and provide `I2N_DATABASE_URL` or `I2N_DATABASE_URL_FILE`. `I2N_WEB_DIR` defaults to `client/dist/web`; the server image uses `/usr/local/share/i2nclip/web`. JavaScript and CSS builds are not minified.

```sh
export I2N_ORIGIN=https://clip.example.com
# Provide the PostgreSQL URL through a private environment file or secret manager.
cargo run
```

For local development, `make dev` builds the server image and starts PostgreSQL 18 through Podman Compose. Both published ports bind to loopback. Use a working Podman API socket and Compose provider.

```sh
make dev
make dev-otc            # issue an invitation in another terminal
make dev-down           # preserve the database volume
make dev-db             # start only PostgreSQL
make run                # run Rust against the development database
npm run dev --prefix client
```

`DEV_PORT`, `DEV_DB_PORT`, and `DEV_ORIGIN` override development addresses; `DEV_DB_URL` overrides the database URL. For a separate Vite server, set `DEV_ORIGIN=http://localhost:5173`. Vite proxies `/api/` to port 8080, configurable through `I2N_API_TARGET`.

PostgreSQL holds encrypted blocks, hash-addressed ciphertext blobs, library public keys and quotas, invitations, and nonces. Chain append, storage effects, and counters commit atomically. Downloads release database connections before sending owned bytes. The eight-connection SQLx pool has a five-second acquisition timeout. Startup applies the embedded schema transactionally once; maintenance removes expired invitations and nonces on startup and hourly. See [protocol and backend documentation](doc/README.md).

## Verification

| Command | Coverage and access |
| --- | --- |
| `make test` | Client unit tests, Biome/Svelte checks, Rust unit/configuration tests |
| `make lint` | Clippy and client Biome/Svelte checks |
| `make format-check` | Rust formatting and import grouping |
| `make test-build` | Web and unpacked extension build contents |
| `make test-db` | PostgreSQL API tests; provisions a disposable container unless `I2N_TEST_DATABASE_URL` is set |
| `make test-e2e` | Firefox/Chromium web tests against real Rust and isolated databases; installs dependencies and browsers |
| `make test-profile` | Linux transfer/resource measurements in a disposable PostgreSQL container |
| `make test-all` | All portable suites, sequentially; resource profile is separate |

With an existing disposable PostgreSQL administrator connection, set `I2N_TEST_DATABASE_URL` and run `npm run e2e --prefix client`. Screenshots use per-test directories under ignored `client/e2e/shots/`. See [client architecture](client/README.md) for state ownership.

Formatting commands use stable Rust 1.99.0 / rustfmt 1.10.0, with import grouping supplied through `--config` (these settings remain unstable in configuration files). `make format-write` applies Rust formatting and Biome fixes; `make pre-commit` then verifies Clippy and client checks. Rust builds warn on redundant qualification, and Clippy treats warnings as failures.

Client Makefile targets prepare locked dependencies automatically. Browser tests build their Rust helpers and bind isolated listeners to loopback port 0. PostgreSQL uses a disposable container with a random host port unless an administrator URL is explicitly supplied. See [test preparation and isolation](doc/test-pipeline.md) for fresh-clone prerequisites and commands.

