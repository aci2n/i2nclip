# HTTPS server URLs

Change specification for audit finding A2 ([audit](audit-2026-10-22.md)).

## Goal

Every request, block page and blob exchanged with the server travels over the
configured server URL. Plain HTTP to a remote host exposes metadata and access
patterns and lets a network attacker withhold or replay pages. Server URLs must
use HTTPS, except plain HTTP on loopback (`localhost`, `127.0.0.1`, `[::1]`) for
local development and tests. This matches the extension's app-URL rule, the
pairing rule, and the `connect-src` policy in
[content security policy](content-security-policy.md).

## Scope

`checkServer` in `client/src/lib/protocol/server.ts` enforces the rule. Its
callers already cover setup, the API client and credential parsing
(`library-identity.ts`), so credentials naming a remote `http:` origin are
rejected when opened. `pairingOrigin` drops its duplicate check and relies on
`checkServer`. The error reads: "Use an HTTPS server URL. HTTP is allowed for
localhost, 127.0.0.1, or [::1]."

## Exclusions

No server change, no migration of stored credentials (greenfield), and no
change to the extension, which already applies the same rule.

## Acceptance

Client unit tests: remote `http:` URLs, credentials and pairing are rejected;
HTTPS and loopback HTTP are accepted. `make -C client test` passes.
