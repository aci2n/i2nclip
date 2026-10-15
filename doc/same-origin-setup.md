# Use the app server during setup

## Goal and scope

Remove editable server configuration from Create and Pair device setup. New
libraries register against the origin serving the web app; pairing receivers use
the session's server origin without a user-entered URL. Remove the setup draft,
disclosure, and unused styles. Make session.create accept only the invitation
code and use its existing default server origin. The session's injected default
remains available for isolated environments.

## Interfaces and ownership

Setup passes the ordinary create callback directly and passes the session origin
to the existing pairing workflow. The session store owns registration and identity
persistence as before. API signing continues to include the normalized server
origin; server verification and I2N_ORIGIN configuration remain unchanged.

## Persistence, lifecycle, failure, and exclusions

Keep serverUrl in encrypted identities, recovery files, pairing payloads, and
credentials. Existing recovery and unlock behavior remains unchanged; removing a
setup control does not rewrite restored identities. No format changes, migrations,
new state, dependencies, or extension app-URL changes. Cancellation, registration
failures, pairing failures, and busy guards retain their current ownership and UI.

## Acceptance checks

Create and Pair device expose no server field or disclosure. Creation chooses the
session default origin, pairing uses the session origin, and restore remains
available. Signed requests still contain their target origin. Existing creation
fixtures use an injected origin and no create-time server argument. The Svelte
checker/build pass without warnings. No additional tests are added or run.
