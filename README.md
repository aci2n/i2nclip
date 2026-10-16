# i2nclip

An encrypted media library. The browser encrypts files, filenames, tags, and previews before upload. The Rust server stores ciphertext, public keys, and tag fingerprints.

## Set up a library

Open the web app and create a master password of at least eight characters. In Settings, choose **Create** and enter an invitation code from the administrator. Server configuration is in a disclosure and defaults to the app's origin.

Download a recovery file before uploading. Its independently chosen recovery password encrypts your library identity and server URL. Keep the file and its password: the server cannot recover either. **Restore** is available when this client has no library configured.

To connect another device, open **Connect another device** in Settings on the unlocked device and create a pairing code. On the new device, create its master password, choose **Pair device**, and enter the code using the same server. Compare both verification codes before choosing **Codes match — send library**. Pairing gives full access to the same library without another invitation. Codes expire after two minutes; HTTPS is required except on loopback development servers. See [device pairing](doc/pairing.md).

Each browser profile saves one password-protected library identity in localStorage. Reloading requires unlocking again. Only one tab per app origin may run; additional tabs show a retry screen. The header’s **Lock** button cancels active work and releases decrypted state. **Forget library** removes the local identity while keeping the master password; resetting a locked client removes all its saved state. Neither action deletes server files.

The server allows one active upload and two active content downloads per library
key, alongside global limits of four uploads and sixteen downloads per server
instance. Further transfers wait; devices sharing a key share its permits.

Uploads run sequentially and continue after individual failures. Failures show status messages; select failed files again through Upload to try again. Upload status survives navigation but is not saved across reloads. After an uncertain upload response, check the library before retrying to avoid duplicate copies.

JPEG, PNG, and BMP uploads are converted to WebP by default when the result is smaller,
without resizing. Turn off **Compress images to WebP** in Settings to preserve
originals. This preference stays on this device and also applies to extension captures.

Search by adding tag chips with Enter or choosing a local suggestion. All selected tags must match. Remove a chip to update results, or use **Clear search** to restore all files. **Upload** opens the file picker independently of the search. Progress
appears below the toolbar; completed filenames expand from the summary, while
failures stay visible.

Open an image, text/code file, or play audio/video to preview it. Text is shown
read-only, with a labeled 256 KiB preview limit; Download saves the full file.
Use the arrow buttons or Left/Right keys to browse previewable files in the loaded results.
To load another results page, close the preview and choose More. A centered
percentage appears on the card and in the preview while content downloads.
Browsing remains available during loading; switching items or closing cancels the
pending preview download. Completed content stays cached. Escape closes the preview.
On touch screens, swipe left/right to browse and swipe up to close media previews.
Text previews retain vertical scrolling; close them with the close button.

Tags edit inline: **+** opens an input, Enter saves, Escape cancels, and **×** removes a tag. Failed edits retain their draft. Tag controls and card actions have larger touch targets on narrow screens; preview arrows sit below the content.

Click a filename to edit it. Enter saves its metadata; blur exits without saving, and Escape cancels the draft.

The project is greenfield; there are no client data or recovery-format migrations.

The navigation contains Library and Settings. **About**, at the bottom of Settings, opens version and project information.

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

Administrators issue invitations with the Rust executable:

```sh
i2nclip otc issue
i2nclip otc issue --ttl-secs 3600
i2nclip otc issue --max-bytes 1073741824 --max-files 20000
i2nclip key set-limits PUBLIC_KEY --max-bytes 536870912 --max-files 10000
podman exec i2nclip i2nclip otc issue
```

Settings → **Your library** shows storage and file usage. It refreshes when opened
and after an upload batch finishes while Settings is open; failed reads offer Retry.

Each key defaults to 512 MiB (536,870,912 bytes of encrypted content) and 10,000
files. Invitations carry their chosen limits to newly registered keys. Registering
an existing key again preserves its limits. Both limit flags are required for
`key set-limits`; values are nonnegative decimal integers up to 9223372036854775807.
Zero blocks uploads. Paired devices share one key and quota. Lowering a quota
below current usage is rejected without changing limits or files. Downloads, metadata
edits, and deletion remain available; deletion frees capacity automatically.
Database checks enforce used bytes and file count at or below their limits.
Limits and current usage live in a separate `key_quotas` row per public key;
`registered_keys` remains key-only. Uploads reserve bytes and a file slot, and
deletes release them, in the same transaction as the media change. Each quota
check reads one row, without summing the library. Metadata edits do not change usage.
Quota failures return HTTP 409 with `Library storage limit reached.` beside the
upload. Sizes include encryption overhead, but exclude metadata and PostgreSQL
storage overhead. Leave disk headroom for metadata, indexes, WAL, and dead tuples.

Startup runs embedded SQLx migrations from `sql/`, beginning with `001_init.sql`,
before accepting requests. Applied versions and checksums are recorded in
`_sqlx_migrations`; restarts skip applied SQL and preserve limits and counters
without scanning media. Add future changes as new numbered files; keep applied
migrations unchanged. Databases predating this infrastructure must already match
the initial schema. See [Database migrations](doc/database-migrations.md).

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

PostgreSQL holds ciphertext, metadata, keys, invitations, nonces, and tags. Uploads and metadata changes commit atomically. Downloads release database connections before sending owned bytes. The eight-connection SQLx pool has a five-second acquisition timeout. Startup initializes the idempotent schema transactionally; maintenance removes expired invitations and nonces on startup and hourly. See [protocol and backend documentation](doc/README.md).

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

Uploads receive up to 40 automatic tags from their stored media type, format and filename words. They are ordinary editable tags; edits never regenerate them. Each file allows 64 tags total. Cards show six tags initially; **Show all tags** reveals the rest. Existing files are unchanged.

The authenticated tag catalog returns opaque search tokens with encrypted labels. Labels are decrypted and verified only in the unlocked client, held in memory, and refreshed after changes. Existing files remain searchable but enter autocomplete only after metadata is saved. No backfill runs. Deploy the updated client and server together when changing the tag frame format.
