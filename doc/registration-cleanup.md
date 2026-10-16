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
