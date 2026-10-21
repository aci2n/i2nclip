# Branch review — 2026-10-21

Reviewed snapshot: `a70fcebac115c5aef2c48fb9a4fbca8ca48de7a7`.

This note records observations for later review. It does not authorize fixes or
supersede the current protocol specifications. Subsequent commits and working-tree
changes may resolve or alter these findings; reassess each against the implementation
before preparing a change specification. Source links name the reviewed modules;
use the commit above when their current contents differ.

The review covered server storage, authentication, chain replay, offline recovery,
pairing, file encryption, and client ownership. The strongest finding was an
unauthenticated denial-of-service path. No signature forgery or plaintext-disclosure
flaw was demonstrated.

## Findings

### 1. High: unknown keys consume shared upload capacity and nonce storage

[`ProofRequest`](../src/auth.rs) accepts possession of any self-generated signing
key and inserts its nonce before endpoint-specific authority is established.
The [block append handler](../src/chain_routes.rs) then acquires the same four
global upload slots used for legitimate uploads before establishing library
authority. Four unknown keys can hold those slots with incomplete bodies for
ten seconds. Rotating keys bypasses the per-key limit. Repeated invalid requests
also produce database writes without registration.

Suggested remedy: separately bound admission for unknown/replacement principals,
including limits before nonce insertion and body reading. Preserve the ability
of a replacement device to submit its exact recovery-approved reset.

### 2. Medium: helper modules own workflows and access stores

[`files.ts`](../client/src/lib/files.ts) owns cancellation, synchronization,
staging, and chain mutations. [`device-verification.ts`](../client/src/lib/device-verification.ts)
and [`library-recovery.ts`](../client/src/lib/library-recovery.ts) construct and
dispose stores, storage, and transports. These responsibilities violate the
repository's ownership boundary for helper modules and asynchronous workflows.

Suggested remedy: move these responsibilities into explicitly owned stores or
resource-owning services, keeping protocol transformations independent of stores.
Components inspected receive ordinary state and callbacks. Their type-only imports
from store modules do not constitute runtime store access.

### 3. Medium: a recovery security test passes for the wrong reason

The test named `invalid encrypted history is rejected before accepting its head`
in [`library-recovery.test.ts`](../client/tests/library-recovery.test.ts) intends
to verify rejection of an authenticated malformed operation. Instead, it replaces
the entire history with a device-signed data block at sequence 1. Replay rejects
it before examining the malformed operation because the first block must be a
recovery-signed enrollment.

A standalone reproduction returned:

```text
Invalid chain operation: first block must be recovery-signed enrollment.
```

Suggested remedy: retain valid enrollment and append the malformed record after
it. Assert the payload-specific failure and that the trusted head remains at the
valid prefix.

### 4. Medium: replacement-credential construction is duplicated

[`rotationReplacement()`](../client/src/lib/protocol/device.ts) already constructs
replacement credentials, advances the epoch keyring, and selects the accepted
head. [`devices.ts`](../client/src/lib/stores/devices.ts) reconstructs the same
transition separately, and [session finalization](../client/src/lib/stores/identity.ts)
contains another variant. Validation and phase handling can drift across these
security-sensitive routines.

Suggested remedy: reuse the existing constructor while keeping outcome
verification with the owning store.

### 5. Low: IndexedDB lifecycle handling is duplicated

[`database.ts`](../client/src/lib/database.ts) retains connection, disposal, and
transaction state in factory closures, contrary to the private implementation
class convention. [`chain-storage.ts`](../client/src/lib/chain-storage.ts) repeats
connection opening, blocked/version-change handling, cancellation, and disposal.

Suggested remedy: convert the former to the prescribed private class and consider
a small shared connection-lifecycle implementation. A general persistence framework
is unnecessary.

### 6. Integration gap: epoch-envelope support has no runtime callers

[`epoch-envelope.ts`](../client/src/lib/protocol/epoch-envelope.ts) has no production
callers. Pairing proves encryption-key possession, but [enrollment](../client/src/lib/stores/chain-pairing.ts)
records only the signing key. Runtime rotation still revokes all devices and
installs one replacement.

This matches the reviewed runtime specification. Device-preserving rotation is a
[specified follow-up](device-preserving-rotation.md), refined by
[canonical genesis and separate enrollment](genesis-and-recovery-enrollment.md).
Treat these helpers as unfinished integration, not an implemented security
capability or a demonstrated primitive flaw.

## Server storage assessment

The server stores a signed log plus transactional projections for membership,
file lifecycle, quota, and the current head. No clear redundant server payload
copy was found that warranted removal.

| Stored representation | Assessment |
| --- | --- |
| Genesis bytes and library hash | Canonical identity plus its indexed address; justified. |
| Block sequence, parent, signer, and hash alongside signed bytes | Supports lookup, constraints, authorization, and append serialization; allowed performance duplication. |
| Membership and revocation rows | Transactional authorization projection; justified. |
| File status and purge tombstones | Enforces lifecycle and prevents identifier reuse after purge; justified. |
| Quota counters | Efficient accounting updated under the library lock; justified. |
| Historical metadata and thumbnail ciphertext versions | Required by historical views; reclaimed through file purge under the current model. |

File and blob staging timestamps overlap for unpublished files, but blob timestamps
also govern staged edits to retained files. Relevant implementations are the
[schema](../sql/001_init.sql), [chain effects](../src/db/chain.rs), and
[blob lifecycle](../src/db/blobs.rs).

## Crypto design assessment

- Keep ordinary device signing authority separate from offline recovery authority.
  Combining them would let a compromised device authorize resets.
- Keep Ed25519 signing and X25519 encryption keys separate. Conversion is possible
  but adds validation and implementation complexity.
  [Libsodium recommends distinct keys](https://libsodium.gitbook.io/doc/advanced/ed25519-curve25519).
- HPKE is an appropriate generic primitive for recipient encryption. Retain the
  authenticated pairing layer and signed transition context:
  [HPKE base mode alone does not authenticate the sender](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.1).
- Independent recovery signing material and an epoch derivation secret satisfy
  the explicit native-key-generation requirement. A domain-separated backup-root
  design is possible, but changes that requirement and is not a necessary
  simplification.
- Per-file content keys, positional chunk nonces, dimensional AAD, ciphertext
  hashes, and complete-chunk authentication form a coherent design. No concrete
  nonce-reuse path was found in normal uploads.

The principal simplification opportunities are workflow ownership and reuse of
existing credential-transition routines, rather than merging cryptographic roles.

## Documented security limitations requiring explicit acceptance

These are acknowledged by the current specifications, rather than accidental
implementation divergences.

- **An authorized device can permanently poison replay.** The server cannot
  validate encrypted operation semantics. A correctly signed but undecryptable
  or invalid operation can enter the immutable log; ordinary replay and offline
  recovery stop at it. Rotation does not repair that history.
- **Authorized writers can grow permanent storage without a log quota.** Blob
  quotas do not bound chain records or accumulated historical membership. A
  compromised account can exhaust server storage. Per-request bounds constrain
  individual allocations, not cumulative growth.
- **Recovery-material compromise affects historical and future epochs.** The
  fixed recovery material derives every epoch. Reset excludes old devices but
  does not recover from disclosure of the recovery file and its password.

See [chain storage](blockchain-storage.md) and [offline recovery](library-recovery.md)
for the authoritative guarantees and exclusions. Any stronger recovery or resource
guarantee requires a separate design decision and change specification.

## Verification at the reviewed snapshot

Using Node 22.23.3 from `client/.nvmrc`:

- `npm test --prefix client`: all 47 client test files passed.
- `npm run check --prefix client`: Biome, TypeScript, and Svelte checks passed;
  Svelte reported zero errors and zero warnings.
- `cargo test --lib`: 45 Rust library tests passed.
- Standalone reproduction confirmed the early enrollment rejection in finding 3.

PostgreSQL integration and browser suites were not run. No production code or
tests were changed during the review. Passing checks do not establish the absence
of other security flaws.
