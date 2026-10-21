> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Registration cleanup specification

Goal: simplify signed enrollment in two independently reviewable commits.

First, move request authentication to a module-level auth function shared by the
SignedRequest extractor and registration handler. Keep the explicit registered
and registering key policies and all observable behavior unchanged.

Second, make the registration MessagePack body contain only `otc`. The verified
Authorization signer is the sole source of the enrolled public key. Update the
web API, reference test encoder, protocol documentation and affected tests.
No legacy body fallback, new dependency, schema change or other endpoint change.

Authentication owns signature, key validation, timestamp and nonce checks;
registration owns body limits, decoding and transactional invitation consumption.
Nonce persistence, cancellation, deadlines and invitation/key/quota lifecycle stay
unchanged. Invalid authentication fails before reading a body; malformed bodies
return 400, invalid invitations 403, and failed requests preserve invitations.

Acceptance: both commits build without warnings. Preserve authentication tests;
verify the client signs an otc-only body, the server enrolls its signer, forged
or weak signer headers preserve invitations, and replay/body tampering still fail.
Run client checks, Rust tests with isolated PostgreSQL, formatting and lint.

## Follow-up: registration extractor

Use a distinct RegistrationRequest extractor wrapping the authenticated request.
The registration handler destructures it and retains the same body policy.
SignedRequest extraction always requires an enrolled key; RegistrationRequest
extraction skips only that lookup. Share a private authentication function and
private key policy, without generics, marker traits or duplicated body methods.
No wire, persistence, lifecycle or failure behavior changes. Acceptance: existing
registration, unsigned-request and registered-route tests pass; all targets build
and lint without warnings.
