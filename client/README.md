# Frontend audit guide

This is a Svelte 5 + Vite application shared by a browser page and a Firefox
extension. It does not use SvelteKit routing or server rendering. The public
JavaScript API remains `src/lib/index.js`.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/App.svelte` | Compose the application and dispose it on unmount |
| `src/lib/views/` | Library, Settings, and Upload page markup |
| `src/lib/components/` | Cards, inline tags, unlocking, and the image dialog |
| `src/lib/stores/` | Read-only service projections, UI drafts and page resource ownership |
| `src/lib/service/` | Catalog owner, per-library runtimes, commands/events, identity, IndexedDB and worker host |
| `src/lib/stores/dom.js` | Small browser adapters for focus, dialogs, validation, and file selection |
| `src/lib/protocol/` | Identity, encryption, tag normalization, framing, and recovery format |
| `src/lib/api.js` | Signed HTTP requests and encrypted API payloads |
| `src/lib/media/` | Bounded reads, media preparation, thumbnails, cover art, and formatting |
| `src/lib/platform/web.js` | SharedWorker connection, downloads and confirmation adapter |
| `src/extension/` | Firefox APIs, context menus, and extension entry points |
| `src/app.css` | Theme tokens, typography, and shared controls; component styles stay scoped |

Views render store values and invoke actions. Local input drafts are allowed;
components do not fetch, touch storage, manage object URLs, or await workflows.
The tag editor creates a view-scoped store and disposes its presentation state
on unmount. Its save action delegates to the library and media stores.

## Layout spacing

Containers own spacing. Use `.stack` for vertical groups (1rem gap), `.field`
for a label, its control, and optional hint (0.5rem gap), and `.bar` for inline
controls (0.5rem gap). Labels and actions have no implicit form margins. Keep
hints inside their field and associate them with `aria-describedby`. Disclosures
need an explicit gap between their summary and body. Component-specific layout
stays in its Svelte style block, using the project rem scale.

This applies the proximity and consistent-scale guidance in
[Spectrum spacing](https://spectrum.adobe.com/page/spacing/) and
[GOV.UK spacing](https://design-system.service.gov.uk/styles/spacing/): related
labels, controls, and hints sit closer together than separate fields or actions.
The shared primitives implement those relationships with CSS gap.

## Ownership and transitions

Browser workflows live in `src/lib/service/`. The web host is a named
SharedWorker; the extension host is its background context. Both use the same
command/event contract, engine, and IndexedDB repository. UI stores project
service messages and own drafts, navigation, playback and object URLs.
See [the full state audit and service contract](../doc/client-service.md).


Private keys stay in owner memory. Restart locks the service, retains unfinished
upload sources, and pauses recovery until explicit retry. Interrupted transfers
may already have reached the server; refresh the library before retrying.
Pending registration persists its encrypted identity before registration, and
retries verify registration before spending another invitation.

One sequential queue accepts batches from every page. Closing a page does not
cancel accepted uploads. Source blobs are retained locally until success/discard;
reset and successful server changes discard them. Video previews in the web
build are optional page helpers; originals are accepted before preparation.

Searches and cursors are independent per view. Canonical media edits and upload
status broadcast across views. Pairing state and controls are shared; closing a
page leaves the service's attempt running. DOM confirmations,
save dialogs, playback and resource URLs remain in the requesting page.

## Verification

Use the Node version in `.nvmrc`, then `npm ci --prefix client` from the repo root.
`make test` runs client tests, the Svelte checker, and Rust tests.
`make test-all` from the repo root runs every suite, including package checks,
PostgreSQL integration/resource tests, Firefox/Chromium tests, and the live deployment smoke test.
`make test-e2e` provisions PostgreSQL and installs browser dependencies.
`make extension` builds the XPI without minifying JS or CSS.
`npm run e2e --prefix client` rebuilds and runs the shared suite in Firefox and Chromium against the real local API.

Browser tests are split by settings, library, and popup behavior. `e2e/fixtures.js`
owns the API server, service transport shim, and shared helpers. Screenshots are written to
ignored `e2e/shots/<project>/`; review both themes at desktop, 360 px, and 320 px widths.
The mixed-media test includes landscape, portrait, panorama, playable WAV/WebM,
long names, files, and playback controls. Its video fixture is a one-second test
pattern; FFmpeg is not needed to run tests.

Deferred-promise tests exercise ignored cancellation, stale search and upload
completion, old progress callbacks, identity/server changes, disposal, duplicate
submissions, overlapping pages, and failure/retry. Firefox tests cover form
validation, recovery failures, encryption flows, navigation, modal focus,
inline editing, upload errors, and layout constraints.

Organization follows the shared `src/lib` convention from
[SvelteKit's structure guide](https://svelte.dev/docs/kit/project-structure),
without adding SvelteKit to this Vite project. See also Svelte's guidance on
[stores for async flows](https://svelte.dev/docs/svelte/stores) and
[derived state, effects, props, and scoped styles](https://svelte.dev/docs/svelte/best-practices).

## Node CLI

The CLI imports the same public API and encryption libraries as the extension.
Use Node 22.23.3 from `.nvmrc`; source execution needs no build or additional dependencies.
Run `node client/cli/index.js --help` from the repository root, or
`npm run cli --prefix client -- --help`.

The encrypted recovery file defaults to `$XDG_CONFIG_HOME/i2nclip/recovery.json`,
or `~/.config/i2nclip/recovery.json` when XDG_CONFIG_HOME is unset, empty, or relative.
Export an individual-library recovery file from Manage Library and copy it there, or pass
`--recovery /path/to/i2nclip-recovery.json` to any command. The CLI uses the server
URL in that document and does not store your password or plaintext identity.
New recovery files use mode 0600 and the automatically created directory uses
0700. Existing recovery files are never overwritten.

Passwords are prompted without echo. For scripts, use `--password-file PATH`,
including `/dev/stdin`; one trailing line ending is removed. Creating a library
requires at least eight password characters and confirmation when prompted.
Creation saves the encrypted recovery file before registration. If registration
fails, use `register` with the same recovery file to retry safely.

```sh
node client/cli/index.js create --server https://clip.example.com --otc INVITATION
node client/cli/index.js register --otc INVITATION
node client/cli/index.js list --tags 'photos,holiday'
node client/cli/index.js list --after CURSOR
node client/cli/index.js upload ./photo.jpg --tags 'photos,holiday'
node client/cli/index.js download ID --output ./saved-photo.jpg
node client/cli/index.js tags ID --add 'Favorite' --remove 'holiday'
node client/cli/index.js tags ID --tags 'photos,Favorite'
node client/cli/index.js tags ID --tags ''
node client/cli/index.js delete ID
```

Replace `ID` with a media ID from list/upload output. List returns one page as
JSON `{items, next}`; pass the next cursor with the same search to continue.
Other commands also emit JSON to stdout. Prompts and errors use stderr.
Exit codes are 0 for success, 1 for an operational failure, 2 for invalid command
arguments, and 130 for interruption. Ctrl-C aborts the active request.
Downloads require an explicit path and never overwrite existing files.

Upload accepts exactly one local file, at most 32 MiB. It stores the filename,
content type and tags without generating browser thumbnails. Override content
sniffing with `--content-type TYPE`. Handle batches externally, for example:

```sh
for file in ./photos/*; do
  node client/cli/index.js upload "$file" --tags photos --password-file /path/to/password || break
done
```

Tag editing reads `GET /api/media/{id}/meta` directly and updates through
`PUT /api/media/{id}/meta`, preserving other metadata and the thumbnail. A
concurrent edit produces an error; rerun to fetch the latest tags. The old
`PUT /api/media/{id}` route has been removed; update the server and extension
together.

## Distributable builds

`make packages` from this directory builds and packages web, Firefox extension,
and Node CLI targets. Use `make web`, `make extension`, or `make cli` individually.
All output is under `client/dist/`: `i2nclip-web.zip`, `i2nclip.xpi`, and
`i2nclip-cli.tar.gz`, alongside their `web/`, `extension/`, and `cli/` build directories.
`make build` builds all directories without creating archives.

The web archive contains only static HTML and bundled JS/CSS. The extension
contains its manifest, four page shells, SVG icon, and bundled JS/CSS; update
metadata and unused assets are excluded. The CLI contains one executable Node
ESM bundle with its reachable protocol/API code; Node built-ins stay external,
and no npm dependencies are required after extraction.

The current source boundaries are retained: `src/main.js` is the web entry point,
`src/extension/` owns Firefox entry points, and `cli/` owns Node entry points.
`src/lib/index.js` remains the shared public API. No runtime protocol changes
are made by bundling.

Run `make test-packages` to build and check all packages. See the repository README's
Client packages section for hosting requirements and CLI extraction instructions.

The server container builds only the web target and serves it through the Rust
listener alongside `/api/`. `I2N_WEB_DIR` selects its static directory; local
source execution defaults to `client/dist/web`. Browser E2E builds web, extension,
and CLI artifacts and tests the web client on the Rust listener's own origin.

Browser ownership, messaging, and durable recovery
are described in [the session service guide](../doc/session.md).

## Service message tracing

All browser builds and packages include service tracing, including production.
CLI output remains unchanged.

In Firefox, open `about:debugging#/runtime/this-firefox` and inspect the web
SharedWorker (`web-worker.js`) or the i2nclip extension background context.
Enable Debug/Verbose console messages and filter by `[i2nclip service]`.
Each entry shows direction, client ID, message type/name, and a payload snapshot;
request IDs and sequences correlate commands, replies, and broadcasts.
Credentials, invitations, pairing codes/capabilities, URLs, filenames, tags and
metadata are redacted. Network traces show sanitized routes, HTTP status and
elapsed time; failures report a safe classification without raw error text.
Upload, search, invalidation and pairing phases help locate interrupted work.
Binary data is summarized by type and size; long arrays and deep objects are bounded.

## Multiple libraries

Setup has four tabs: OTC (an invitation), Authorize (an existing registered
library), Pair (another device), and Restore (a recovery file). Authorize is the
default when a registered library exists; the selected
source determines its server. OTC and Pair keep their own server choices, while
Restore uses the recovery file's server.

New setup suggests the lowest unused “Personal N” name; the suggestion is editable
and saved names remain unchanged. Add library expands the same form without
changing the current selection.
Unsubmitted fields stay local. Submitted setups have service-owned provisional
records, appear in the picker only after their identities are saved, and retain
failed registrations for Resume setup after reload. Retrying reuses the encrypted
identity. Manage Library groups rename, server configuration and forgetting;
Reset Browser is always the final disclosure and affects all local libraries.

Each tab chooses its own named library. The vault, catalog,
uploads, pairing and media state are service-owned; names are local and never
sent to the server. Settings can rename or forget the selected library. Adding a
library uses the four-tab setup form without replacing existing entries.
OTC and Authorize create independent identities; Pair and Restore connect existing ones.

Each client first creates one master password. Unlocking grants access to every
saved library across its connected tabs; Lock hides the application and cancels
active work. The web SharedWorker and extension background own separate vaults.
`i2nclip-vault` encrypts names, servers, identities, pending registration, upload
jobs and binary sources. Owner restart locks everything and requires explicit
retry of interrupted uploads. Master-password changes re-wrap the vault key.

Manage Library exports one library, while Back up all libraries exports the
completed catalog. Both use a separately chosen recovery password and exclude
pending uploads. Restore previews the file's libraries before merging them into
the current vault. The destination master password remains unchanged. A forgotten
master password requires resetting local storage and restoring recovery files or
pairing from another unlocked client. Reset does not delete server files.

This is a new development schema and recovery format; former local databases and
recovery format v1 are not migrated. Clear development storage when upgrading.

The CLI selects libraries through `--recovery`. `create` and `register` accept
`--authorize-with FILE` instead of `--otc`, plus `--authorizer-password-file PATH`
for its recovery password. `--password-file` belongs to the destination recovery
file. Whole-vault exports are not CLI inputs; export an individual library first.

The E2E projects use the same tests and Firefox API shim in both engines. Native
installed-extension/CSP checks remain separate. To run one project, pass
`-- --project=firefox` or `-- --project=chromium` to `npm run e2e`. Browser-specific
launch configuration belongs in Playwright configuration, not individual tests.
