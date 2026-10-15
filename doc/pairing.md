# Device pairing

The web app can copy an unlocked library identity to a client with no library configured. Both clients unlock their own password-protected local state first. Pairing copies the full identity: there is no per-device revocation or restricted sharing. Media encryption, request signatures, registration, and pairing packets retain their formats. Recovery independently protects one identity; see [client ownership](session.md).

## Code and authentication

Codes have twelve uniformly random base-32 characters, grouped `XXXX-XXXX-XXXX`.
The first four identify the relay room; the final eight are a 40-bit secret.
The alphabet is `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. Input is case-insensitive and
ignores spaces and hyphens. The secret never appears in a request or URL.

The sending device creates a temporary OPAQUE setup and registration record
locally. `@serenity-kit/opaque` 1.1.0 performs the PAKE in the pairing workflow;
its default memory-constrained Argon2 configuration is used. The receiver is the
OPAQUE client and the sending device is the OPAQUE server. The Rust relay is
neither endpoint and never receives the OPAQUE setup or registration record.
Identifiers bind version, origin, public room ID, random 128-bit room instance,
and participant roles. Client and server identifiers end with `receiver
verification-code` and `sender verification-code` respectively. Verification
support is therefore authenticated: both devices must use updated clients;
mixed old/new clients fail authentication with no fallback. The context prefix
remains `i2nclip/pairing/v1`, and all packet versions and relay steps stay at v1.
Each executor accepts one authentication attempt only.

After authentication, each executor independently derives a 40-bit verification
value with HKDF-SHA256 from the OPAQUE session key, using the pairing context as
salt and `verification-code` as info. Encode the five derived bytes in base-32
with the pairing alphabet, most significant bits first, and display as
`XXXX-XXXX`. These bits use a separate purpose from encryption keys. The executor
exposes the formatted code only in the authenticated sender/receiver phases;
session keys remain inside the executor.

Both devices display **Verification code**. The original pairing code is hidden
on the sender after authentication. Compare the displayed codes on the intended
devices, then choose **Codes match — send library** on the sender. **Codes don't
match** cancels the room and requires a fresh pairing code; no identity is sent.
Codes are never sent through the relay, logged, or persisted, and are cleared
when sending/saving begins or the attempt ends. A comparison is a human check;
the application cannot tell whether the user actually compared both screens.

Verification helps detect an unintended receiver that obtained the original
pairing secret. Independent sessions with the same secret produce independent
verification values, with a 1-in-2^40 accidental match probability per independent
comparison. It does not prevent room claiming, message dropping, or compromised
client builds. Users must cancel if the other device has no verification code.

After authentication and explicit sender approval, HKDF-SHA256 derives separate
AES-256-GCM keys for the identity transfer and save acknowledgment from the PAKE
session key. The HKDF salt is the pairing context and info is `transfer` or
`acknowledgment`. Each packet uses a fresh 12-byte nonce. AAD additionally binds
direction and protocol step. JSON packets contain `v: 1`, `iv`, and `ct` encoded
as unpadded base64url. The identity plaintext contains `v`, `serverUrl`,
`privateKey`, and `publicKey`; the acknowledgment contains `v: 1, saved: true`.

The receiver validates the identity and selected server, checks that no library is configured, and saves the encrypted identity to localStorage before acknowledgment. The master password is never transferred. Session and pairing stores own operation handles and cancellation. Locking, forgetting, replacement, and disposal end the attempt; stale transfers and acknowledgments are rejected. Closing the page ends pairing. Expiry and bounded relay retries remain enforced.

## Relay API

The server holds at most 256 ephemeral rooms in memory, with one active room per
registered library and five creations per library per minute. Rooms expire after
120 seconds without extension. Expired rooms and rate records are pruned on
requests. Server restart abandons all rooms. Multiple server processes require
sticky routing; shared relay storage is outside this version.

Anonymous joins allow ten requests per TCP peer IP and 120 requests globally in
a rolling sixty-second window per server process. Failed participant requests
(polling, submission, and cancellation with invalid capabilities or missing
rooms) share this budget so those endpoints cannot evade room-enumeration
limits. Authenticated participant requests do not spend that budget.
Invalid room IDs, malformed
JSON, and requests whose body reads stall or find all read slots occupied count
toward these limits. Rate-limit rejection returns `429` with `Retry-After: 60`
before reading the body. Rate records are bounded by the global admission limit
and expire without extending the window on rejection.

Source limits use the TCP peer unless it is in `I2N_TRUSTED_PROXIES`.
For trusted peers, the shared resolver checks X-Forwarded-For, Forwarded, then
X-Real-IP and walks trusted chains right-to-left. IPv6 /64s share a budget.
Missing or malformed proxy metadata falls back conservatively; see
[public rate limits](public-rate-limits.md). Hosts embedding the public router
should serve it with Axum's `into_make_service_with_connect_info::<SocketAddr>()`; absent
connection metadata shares one source bucket.

Join and message submission bodies share sixteen read slots. Saturation returns
`503` immediately without buffering or queueing another body. Submission checks
the participant capability before taking a slot or reading bytes. Slots are
released on success, failure, cancellation, and the ten-second body deadline;
polling and cancellation remain available while the body slots are occupied.
The twelve-character code format is unchanged. Rate limits reduce room guessing
and claiming; knowledge of a room ID still permits disruption without the secret.

| Endpoint | Authorization | Payload/result |
| --- | --- | --- |
| `POST /api/pairings` | Existing signed request from registered library | `{v:1}` creates room and returns sender capability |
| `POST /api/pairings/{id}/join` | None; first receiver wins atomically | `{message}` submits OPAQUE initiation and returns receiver capability |
| `GET /api/pairings/{id}/messages` | Participant capability | Current room snapshot |
| `POST /api/pairings/{id}/messages` | Participant capability | `{step,message}` advances the exchange |
| `DELETE /api/pairings/{id}` | Participant capability | Cancels the room; `204` |

Snapshots contain `v`, `id`, `instance`, `remaining_secs`, `step`, and `message`.
Only create/join return `capability`, a random 256-bit token used in the
`Authorization: Bearer …` header. IDs are unique among live rooms; the instance
distinguishes later reuse. No room enumeration endpoint is provided.

Steps are 1 receiver initiation, 2 sender OPAQUE response, 3 receiver OPAQUE finish,
4 sender encrypted identity, and 5 receiver encrypted acknowledgment. Only the
expected participant can submit a step. Identical repeated messages are
idempotent; replacements and skipped steps are rejected. The last message and
step remain available until expiry, including the acknowledgment.
Clients retry a lost poll or submission response once, reusing the exact message.
They never retry room creation/join or start a second PAKE attempt with the same
code. After a successful save, acknowledgment failures do not delete the room,
so an acknowledgment already accepted by the relay remains available.

Request bodies and client-read responses are capped at 16 KiB; message strings
are capped at 8 KiB. Bodies and client requests have ten-second deadlines.
Clients poll once per second with one request in flight, and independently
enforce expiry. Responses are `no-store`. Errors use `401`, `404`, `409`, `413`,
`429`, and `503` as appropriate. Client UI uses fixed error messages; server logs
record lifecycle events/status codes without message bodies or capabilities.

Deploy the relay before the clients. Old servers return a clear unsupported or
ended-pairing error; existing creation and recovery restore remain available.

## Verification

Unit tests cover real OPAQUE exchange, wrong secrets, session bindings, independent HKDF verification vectors, tampering, direction separation, bounded reads, explicit approval, durable-save acknowledgment, cancellation, expiry, and idempotent retries.

Firefox and Chromium tests use independent browser contexts and the real Rust API to transfer an identity after comparing both verification displays. Rust tests cover role capabilities, ordering/idempotency, room/rate/body limits, source spoofing, admission, permit release, and expiry.
