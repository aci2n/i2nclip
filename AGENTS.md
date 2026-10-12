# Project conventions

## Layout and commands

- The server image includes only the web client build, served by Rust on port 8080 alongside the API. `I2N_WEB_DIR` defaults to `client/dist/web` locally and is set to `/usr/local/share/i2nclip/web` in the image.
- The Rust server lives in `src/`. Frontend source, npm tooling, and browser tests live in `client/`.
- `client/` is a Svelte 5 + Vite web project. Reusable crypto, API, media, stores, and components live in `client/src/lib/`.
- Keep one npm project: package.json, lockfile, .nvmrc, and Playwright configuration belong in `client/`.
- The root Makefile delegates frontend commands with `$(MAKE) -C client`; do not include the client Makefile. `make build` builds server and frontend; `make client` builds frontend.
- `make web` and `make packages` package the web client as `client/dist/i2nclip-web.zip`. All outputs stay in `client/dist/`.
- Do not minify JavaScript or CSS unless explicitly needed. The Vite build disables minification. ZIP compression is fine.

## Database policy

- Treat the project as greenfield. Update the initial schema directly. When removing a table or index, remove its creation statement rather than adding a `DROP` statement or legacy cleanup migration. Recreate development databases when schema changes require it.
- SQL `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are fine; reopening a current database must preserve its data.

## State and resource ownership

- Views subscribe to stores and pass plain state and callback props to components. Components must not receive or import stores. Stores own async workflows; components may own presentation state. HTML `id` attributes are forbidden.
- Keep the library store at the app root while navigating between Library and Settings so active uploads and their status survive view changes.
- Use `$state` for bound DOM references read by template handlers. Run the Svelte checker and ensure `make client` builds without warnings.
- Search uses cancellation plus stale-result checks. Pagination belongs to the submitted search and allows only one request at a time.
- Identity or server changes invalidate pending library operations. Upload batches run sequentially and individual failures do not stop the batch. Upload state exists only in memory.
- A failed file must not stop the rest of a batch. Retain only failed files for retry, clear them on identity/server changes, and ignore progress from completed or superseded uploads.
- Use one lifetime Web Lock solely for tab admission, before reading localStorage or creating application stores. Reject overlapping session and media-item mutations with local busy state.
- Media items own decrypted bytes and object URLs. Abort requests and revoke URLs on disposal; stale downloads must not create URLs or open save dialogs.
- Check local file size before reading bytes. Cap content downloads while streaming; do not trust Content-Length alone.
- Preserve the encryption protocol when reorganizing code. Rust and JavaScript share `client/tests/test-vectors.json`; content uses fixed purpose AAD, metadata includes the sealed-content hash in its AAD, and downloads verify that hash before decryption.

## UI conventions and visual review

- Keep component-specific styles in Svelte `<style>` blocks. `client/src/app.css` owns theme tokens, base typography, and shared controls/layout primitives; avoid global selectors that reach into another component. Keep the look simple and consistent, with light/dark themes. Use rem spacing on a .25/.5/.75/1/1.5/2/3 scale, with .125/.375 for compact chip padding; keep tag labels, inputs, and actions separated by explicit gaps.
- Place progress, success, and error messages beside the action that produced them. A status at the bottom of settings can fall below the viewport, especially on narrow screens.
- Use a consistent preview area for images, audio, video, and ordinary files. Mixed aspect ratios otherwise create large gaps in the grid. Preserve the media's aspect ratio within the preview.
- Optimize cards for browsing: readable tags, short format/size summaries, and a disclosure for detailed metadata.
- Edit tags inline: a + button opens an input, Enter saves a chip, Escape cancels, and chips have removal controls. Keep failed drafts, restore focus after saving, and deduplicate by protocol normalization while preserving the first spelling.
- Distinguish an empty library from a search with no matches; provide an upload action or a clear-search action respectively.
- Make Create/Restore the main setup choices. Keep server configuration in a disclosure.
- Inspect actual Firefox screenshots after visual changes. Test realistic landscape/portrait/panorama media, audio and files, long names, errors, both themes, and narrow widths such as 320/360 px. A one-pixel fixture does not reveal card-layout problems.

## Verification

- Install dependencies with `npm ci --prefix client`; use the Node version in `client/.nvmrc`.
- The root Makefile groups all test/verification targets by required access. `make test-packages` builds the web archive and runs package checks without a browser or database.
- `make test` runs client tests, the Svelte checker, and Rust tests. `make -C client test` checks only the client.
- `npm run e2e --prefix client` rebuilds the web app and runs Firefox/Chromium tests. `make test-e2e` also installs dependencies and Firefox.
- E2E tests use the real local Rust web/API listener without runtime shims. Screenshots go to ignored `client/e2e/shots/`; inspect them with the image-viewing tool.
- Browser tests need permission to launch Firefox and communicate with local servers. If sandboxing blocks them, rerun with the appropriate escalation.
