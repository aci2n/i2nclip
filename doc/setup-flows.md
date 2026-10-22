# Setup flows

Change specification for the library setup screen. Frontend only. Replaces the
former setup-order specification (audit finding C2).

## Goal

Setup offered three toggle buttons, a server disclosure, an invitation code asked
twice and destructive actions ("Discard prepared library", "Reset browser") beside
the main ones. It appeared only inside Settings. Users should pick one plainly
named path and then see one step with one main action at a time.

## Placement

- While unlocked and not configured, the Library route shows Setup in place of
  the old "Your library starts here" panel. The media route keeps its Setup
  fallback.
- Unconfigured Settings shows a "Set up your library" link to the Library route
  instead of Setup. Upload preferences, master password and About are unchanged.

## Behavior

`views/Setup.svelte` keeps a local path choice and a local "backup saved" flag;
the session state decides the screen first:

1. **Can't reach your library** (`pendingConnection`): "Try again"
   (`retryConnection`) and "Remove library from this browser" behind a confirm
   (`forget`).
2. **Create, step 2 of 3 · Save your backup** (`prepared`): the existing backup
   controls, the checkbox "I saved the backup file and its password" and
   "Continue", enabled once the backup is downloaded and the box is checked.
3. **Create, step 3 of 3 · Enter your invitation code** (`prepared`, backup
   saved): the code field and "Create library" (`create`), plus "Back". Steps 2
   and 3 offer "Start over" behind a confirm (`forget`). After a reload, or after
   restoring a backup of an unregistered library, the flow resumes at step 2.
4. **Chooser** (`SetupChoices`): "Create a new library", "Restore from a
   backup", "Connect from another device", each with a one-line explanation.
5. **Create, step 1 of 3 · Create your library**: the server disclosure and
   "Create library keys" (`prepareCreation`). No invitation code yet.
6. **Restore from a backup**: backup file, backup password, "Restore library".
   No server field; the backup carries it.
7. **Connect from another device**: the server disclosure and `PairingReceive`.

Steps 5–7 have "Back" to the chooser. Session errors and notices render under the
visible step. Setup no longer offers a browser reset; the locked Unlock screen
keeps its own.

## Exclusions

No session-store, pairing, protocol, backup-format or routing changes and no new
persisted state. The store still requires a downloaded backup before
registration; the checkbox and step flag are presentation state. The Unlock
screen is unchanged.

## Acceptance

`make -C client test` and `make client` pass without warnings. E2E helpers and
specs use the new labels and placement. E2E runs and Firefox screenshots of every
step in both themes at 320/360 px and desktop widths remain pending explicit
approval.
