# i2nclip

Encrypted media store. The browser encrypts each file in your browser before upload. The server keeps ciphertext, public keys, and tag fingerprints. It cannot read the files.

## Set up your library

Open the extension settings, use the default server (`https://clip.i2n.duckdns.org`) or enter your own URL and an invitation code from the admin, then choose an unlock password of at least 8 characters and click **Create library**. The browser generates the library identity and registers its public key automatically.

Download your **recovery file** before uploading. It contains your encrypted library identity and server URL. Keep it and remember your password: both are required to restore your library in another browser. The server cannot recover either for you. Settings also let you download the recovery file again later.

The password encrypts the identity in your Firefox profile and recovery file. It is never stored or sent to the server. Firefox asks for it once each session; the unlocked identity stays in session storage until Firefox exits. Restore accepts only i2nclip recovery files and is available when no library is configured. To switch libraries, download your recovery file, then click **Reset everything**. Reset clears the browser's saved settings and session; uploads on the server stay saved. You can then create a library or restore a recovery file.

Registration happens automatically during creation. The library identity is saved and unlocked only after registration succeeds. If registration fails, check your invitation code and try again; no reset is needed.

Admin (on the host or in the container data volume):

```sh
i2nclip otc issue              # prints a code (default TTL 24h)
i2nclip otc issue --ttl-secs 3600
podman exec i2nclip i2nclip otc issue
```

## Run

The process listens on `0.0.0.0:8080` and uses `/var/lib/i2nclip`. Set `I2N_ORIGIN` to the public HTTPS origin users type in the browser, with no path—for example `https://clip.example.com`. Request signatures name that origin, not the `Host` header on the upstream connection.

```sh
make test
cargo run
```

`make test` runs Rust tests, client tests, and the Svelte checker. Install the client dependencies first with `npm ci --prefix client` (Node 22 from `client/.nvmrc`). `cargo run` needs a writable `/var/lib/i2nclip`.

For a local container:

```sh
make container
podman run --rm -p 8080:8080 \
  -e I2N_ORIGIN=https://clip.example.com \
  -v i2nclip-data:/var/lib/i2nclip:Z \
  localhost/i2nclip
```

Image builds use host networking so they also work where rootless Podman's
`pasta` cannot access `/dev/net/tun`. Build steps share the host network;
override with `make container CONTAINER_NETWORK=private` to use Podman's
isolated build networking on hosts that support it.

The image runs as uid 10001. For a bind mount:

```sh
mkdir -p data-dir
podman unshare chown 10001:10001 data-dir
podman run --rm -p 8080:8080 \
  -e I2N_ORIGIN=https://clip.example.com \
  -v ./data-dir:/var/lib/i2nclip:Z \
  localhost/i2nclip
```

## Self-hosting

i2nclip serves plain HTTP on port 8080 inside the container. It does not terminate TLS, set security headers, or rate-limit clients. Run it on a private network or localhost and put a reverse proxy in front (Caddy, nginx, Traefik, etc.) for:

- **HTTPS** — certificates and redirects from HTTP to HTTPS.
- **Public hostname** — set `I2N_ORIGIN` to that `https://` origin so signatures match what the extension uses.
- **Rate limiting and abuse controls** — especially on `POST /api/register-key` and failed authenticated requests; the app itself does not throttle.
- **Optional path prefix** — not supported: the API lives at `/api/…` on the site root. Prefer a dedicated host or subdomain.

| Artifact | Purpose |
| --- | --- |
| `Containerfile` | Builds `localhost/i2nclip:latest` |
| `deploy/i2nclip.container` | Example Podman quadlet with a published port |
| `make push` | Optional: build the image and stream it over SSH into the remote user's Podman image store (`HOST` in `local.mk`) |

Typical setup:

1. Build and run the container with a persistent volume on `/var/lib/i2nclip` and `I2N_ORIGIN` set to your public URL.
2. Point the proxy at `http://127.0.0.1:8080` (or the container on an internal network) and do not expose 8080 on the public internet unless you intend to.
3. Issue a one-time code for each new user (`i2nclip otc issue`) and send it to them over a trusted channel.

Data lives in the volume: `i2nclip.db`, `blobs/`, and registered public keys. Back up the whole directory.

### Orphan blob cleanup

Upload writes `blobs/<id>` before the SQLite row exists. A crash in between leaves a file that nothing lists. The server does not remove these automatically.

```sh
i2nclip gc-blobs --dry-run   # list eligible orphans
i2nclip gc-blobs             # delete them (default: blob mtime at least 1 hour old)
i2nclip gc-blobs --min-age 0 # no age guard (tests / manual only)
```

Schedule `gc-blobs` periodically (cron or a systemd timer), for example weekly:

```sh
podman exec i2nclip i2nclip gc-blobs --dry-run
podman exec i2nclip i2nclip gc-blobs
```

Only files named like a lowercase uuid with no matching `files.id` are candidates. Orphans newer than the minimum age (one hour by default) are left in place so GC cannot delete a blob while an upload is still inserting its row. Anything else under `blobs/` is counted as ignored and left in place.

The SQLite database uses WAL mode so a GC read can overlap normal writes. Back up or copy `i2nclip.db` together with `i2nclip.db-wal` and `i2nclip.db-shm`, or checkpoint first.

This does not repair the opposite problem (a row with a missing blob). Download already returns 404 for that id.

## Requests

One Ed25519 signature covers the origin, time, a one-time nonce, the method, the path, and the SHA-256 of the body. The hash is in the `Authorization` header, so the server checks the signature before it reads the body, then checks that the bytes match. A signature is good for five minutes and cannot be replayed. Each file is at most 32 MB.

Duplicate upload UUIDs return `409`, even for identical files. If an upload response is lost, refresh the library before uploading again: a retry cannot confirm whether the original upload succeeded. The extension keeps the UUID across retries to avoid creating another copy.

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
