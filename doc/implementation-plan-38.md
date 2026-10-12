# Implementation plan: item 38 — Remove saved-server URL editing

## Goal and scope

Saved libraries display their server as read-only text. Server inputs remain in OTC and Pair setup; Authorize derives its server from the selected saved authorizer. Follow [the implementation guide](implementation-guide.md).

This is removal of a Settings capability. Retain owner/server-validation helpers used by tests or non-UI callers unless their callers are proved obsolete. Do not redesign the server protocol or recovery format.

## Code map

- `views/Settings.svelte`: `serverControls` snippet, `savedServer`, bound server DOM refs and `notice("server")`.
- `App.svelte`: management snippet currently receives `serverControls` and passes it to ManageLibraries.
- `components/ManageLibraries.svelte`: renders `serverControls?.()` inside its fieldset.
- `components/Setup.svelte`: OTC `#server`/`#setup-server`, Pair `#pair-server`, and authorizer server summary.
- `stores/settings.js::setServer()` is the editor's action; `session.js`/`service/identity.js` also expose lower-level setServer.
- `e2e/fixtures.js::openServer()` currently supports both initial and configured disclosures; several tests use it.

## Implementation sequence

1. Delete the configured-server disclosure/form and its bound refs, derived value, styles and feedback branch that become unused. Preserve the configured summary's saved name and URL.
2. Change `management(serverControls)` in App to a zero-argument snippet and update its invocation and ManageLibraries props together. Do not leave a dangling snippet argument or unused `serverControls` prop.
3. Keep OTC and Pair inputs in Setup and their validation. Additional OTC uses its typed server; Pair uses its pairing server. Authorized creation reads the selected authorizer server in the owner (item 36), even if an unrelated OTC field contains another URL.
4. Search all `settings.setServer`, `session.setServer`, `identity.setServer`, `server-details`, `save-server` and `openServer` callers. Remove editor-only store methods and state handling. Retain lower-level owner methods still exercised for context invalidation or other supported callers; note those uses. Removing the button alone must not break registration/pairing validation.
5. Update browser helpers/tests to fill server inputs inside the intended setup panel. Delete tests whose sole purpose was the removed editor; replace their acceptance with immutable saved-server assertions. Do not have a fixture silently fall back to editing a saved library's server.

## Acceptance and verification

- Configured Settings contains no saved-server editor, Update URL action or obsolete server feedback/disclosure; the current library URL remains visible as text.
- Add Library can still configure OTC/Pair against a different server. Changing these fields does not mutate the selected saved library.
- Switch between saved libraries on different servers: summary and operations use each library's stored URL; authorizer selection follows its server.
- Recovery import and paired identities retain their encoded server. Existing server URL validation rejects unsupported input.

Run relevant settings/catalog/identity tests, focused settings/setup/pairing E2E and client checks/extension build. Inspect a narrow Firefox Settings shot with a long saved URL in both themes.

## Implementation notes

Removed the saved-server form, snippet plumbing and editor-only settings/session actions. Saved URL remains in the configured summary. Browser helpers now explicitly open first-library setup inputs; OTC/Pair drafts remain editable and authorization uses the owner server. Retained `identity.setServer` for supported owner/context-invalidation tests. Replaced browser editor expectations with immutable saved-server assertions. Combined verification deferred until the end of TODOs 37–46.
