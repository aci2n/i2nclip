# i2nclip

An encrypted media library. The browser encrypts files, filenames, tags, and previews before upload. The Rust server stores ciphertext, public keys, and tag fingerprints.

## Set up a library

Open the web app and create a master password of at least eight characters. In Settings, choose **Create** and enter an invitation code from the administrator. The app uses the server at its own origin; no server URL is needed during setup.

Download a recovery file before uploading. Its independently chosen recovery password encrypts your library identity and server URL. Keep the file and its password: the server cannot recover either. **Restore** is available when this client has no library configured.

To connect another device, open **Connect another device** in Settings on the unlocked device and create a pairing code. On the new device, create its master password, choose **Pair device**, and enter the code using the same server. Compare both verification codes before choosing **Codes match — send library**. Pairing gives full access to the same library without another invitation. Codes expire after two minutes; HTTPS is required except on loopback development servers. See [device pairing](doc/pairing.md).

Each browser profile saves one password-protected library identity in localStorage. Reloading requires unlocking again. Only one tab per app origin may run; additional tabs show a retry screen. **Lock** cancels active work and releases decrypted state. **Forget library** removes the local identity while keeping the master password; resetting a locked client removes all its saved state. Neither action deletes server files.

Uploads run sequentially and continue after individual failures. Failures show status messages; select failed files again through Upload to try again. Upload status survives navigation but is not saved across reloads. After an uncertain upload response, check the library before retrying to avoid duplicate copies.

Open an image or play audio/video to preview it. Use the arrow buttons or
Left/Right keys to browse images, audio, and video, loading the next results page
when needed. A centered percentage appears while the next item downloads;
Escape closes the preview.

Click a filename to edit it. Enter saves its metadata; blur exits without saving, and Escape cancels the draft.

The project is greenfield; there are no client data or recovery-format migrations.

## Firefox extension

Run `make extension` (Node from `client/.nvmrc` and zip are required). The unpacked
extension is in `client/dist/extension/`; its archive is
`client/dist/i2nclip-extension.zip`. In Firefox, open `about:debugging`, choose
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

Administrators issue invitations with the Rust executable:

```sh
i2nclip otc issue
i2nclip otc issue --ttl-secs 3600
podman exec i2nclip i2nclip otc issue
```

## Build and run

Use Node from `client/.nvmrc` and an installed Rust toolchain:

```sh
make build              # prepares locked client dependencies
make web                 # client/dist/i2nclip-web.zip
```

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

PostgreSQL holds ciphertext, metadata, keys, invitations, nonces, and tags. Uploads and metadata changes commit atomically. Downloads release database connections before sending owned bytes. The eight-connection SQLx pool has a five-second acquisition timeout. Startup initializes the idempotent schema transactionally; maintenance removes expired invitations and nonces on startup and hourly. See [protocol and backend documentation](doc/README.md).

## Verification

| Command | Coverage and access |
| --- | --- |
| `make test` | Client unit tests, Svelte checker, Rust unit/configuration tests |
| `make lint` / `make format-check` | Rust and client static checks |
| `make test-packages` | Web ZIP contents; requires zip and unzip |
| `make test-db` | PostgreSQL API tests; provisions a disposable container unless `I2N_TEST_DATABASE_URL` is set |
| `make test-e2e` | Firefox/Chromium web tests against real Rust and isolated databases; installs dependencies and browsers |
| `make test-profile` | Linux transfer/resource measurements in a disposable PostgreSQL container |
| `make test-all` | All portable suites, sequentially; resource profile is separate |

With an existing disposable PostgreSQL administrator connection, set `I2N_TEST_DATABASE_URL` and run `npm run e2e --prefix client`. Screenshots use per-test directories under ignored `client/e2e/shots/`. See [client architecture](client/README.md) for state ownership.

Client Makefile targets prepare locked dependencies automatically. Browser tests build their Rust helpers and bind isolated listeners to loopback port 0. PostgreSQL uses a disposable container with a random host port unless an administrator URL is explicitly supplied. See [test preparation and isolation](doc/test-pipeline.md) for fresh-clone prerequisites and commands.
