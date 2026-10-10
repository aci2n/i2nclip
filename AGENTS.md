# Project conventions

## Layout and commands

- The Rust server lives in `src/`. All frontend source, npm tooling, browser tests, and extension assets live in `client/`.
- `client/` is a Svelte 5 + Vite project. Reusable crypto, API, media, stores, and components live in `client/src/lib/`. Firefox APIs belong only in `client/src/extension/`, behind the platform adapter.
- Firefox's manifest, page shells, icons, and update metadata live in `client/public/`. Build before loading `client/dist/extension/manifest.json` as a temporary add-on.
- Keep one npm project: `client/package.json`, its lockfile, `.nvmrc`, and Playwright configuration all belong in `client/`.
- The root Makefile delegates frontend commands with `$(MAKE) -C client`; do not include the client Makefile. `make build` builds server and frontend, `make client` builds frontend, and `make extension` builds and packages the add-on.
- Packaging is `npm run pack:extension` inside `client/`, using the system `zip` command. No Python packaging script is needed. The XPI is `client/dist/i2nclip.xpi`; runtime files belong at its root. Exclude update metadata and remove stale build entries when repacking.
- Do not minify JavaScript or CSS unless explicitly needed. Both Vite builds disable minification. ZIP compression is fine.

## Database policy

- Treat the project as greenfield. Update the initial schema directly. When removing a table or index, remove its creation statement rather than adding a `DROP` statement or legacy cleanup migration. Recreate development databases when schema changes require it.
- SQL `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are fine; reopening a current database must preserve its data.

## State and resource ownership

- Components render state and invoke actions; stores and services own async workflows. Avoid direct DOM mutation or Firefox storage calls in reusable UI components.
- Keep the library store at the app root while navigating between Library and Settings so active uploads and their status survive view changes.
- Use `$state` for bound DOM references read by template handlers. Run the Svelte checker and ensure `make extension` builds without warnings.
- Search uses cancellation plus stale-result checks. Pagination belongs to the submitted search and allows only one request at a time.
- Identity or server changes invalidate pending library operations. Upload batches run sequentially; pending context-menu uploads have individual IDs and remain available after failures.
- A failed file must not stop the rest of a batch. Retain only failed files for retry, clear them on identity/server changes, and ignore progress from completed or superseded uploads.
- Serialize session mutations across pages with the session Web Lock. Prevent overlapping mutations on a media item.
- Media items own decrypted bytes and object URLs. Abort requests and revoke URLs on disposal; stale downloads must not create URLs or open save dialogs.
- Check local file size before reading bytes. Cap remote reads while streaming; do not trust Content-Length alone.
- Preserve the encryption protocol when reorganizing code. Rust and JavaScript share `client/tests/test-vectors.json`; file IDs are part of AES-GCM associated data.

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
- `make test` runs client tests, the Svelte checker, and Rust tests. `make -C client test` checks only the client.
- `npm run e2e --prefix client` rebuilds the extension and runs Firefox tests. `make e2e` also installs dependencies and Firefox.
- E2E tests use a real local Rust API and a Firefox API shim. Screenshots go to ignored `client/e2e/shots/`; inspect them with the image-viewing tool.
- Browser tests need permission to launch Firefox and communicate with local servers. If sandboxing blocks them, rerun with the appropriate escalation.
