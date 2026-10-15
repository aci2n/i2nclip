# Configurable setup server

## Goal and scope

Restore the server URL disclosure removed by 5c5f516 for Create and Pair device.
Default the local setup draft to the session server URL. Create passes the trimmed
URL to session.create; pairing passes it to pairing.receive. Restore continues to
use the server in the recovery identity.

## Interfaces and ownership

Setup owns only the draft and presentation. The session owns server validation,
registration, cancellation, and encrypted identity persistence. Pairing owns its
existing workflow. Keep the selected server origin in request signatures.

## Persistence and lifecycle

The draft lasts for the setup view lifetime. Successful creation persists the
selected server with the identity through the existing encrypted storage. Busy
state disables editing; existing session and pairing failures remain beside their
actions. Existing cancellation and overlapping-operation guards remain in place.

## Exclusions and acceptance checks

No new settings, storage, protocol changes, migrations, dependencies, or server
routing changes. Create and Pair expose the disclosure with the current origin
as default, use the trimmed selection, and preserve signed-origin validation.
Restore has no independent server field. Update existing session fixtures to pass
the selected URL. Check Svelte and the production build without warnings, and
inspect the restored disclosure in Firefox. No additional tests are added or run.
