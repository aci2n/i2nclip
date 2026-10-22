# Record non-browser integration verification

## Goal and scope

Run the union of affected non-browser tests after integration without repeating unrelated checks. Verify fresh database initialization/reopening, registration/body admission, chain trust and resource ownership. Record actual results and all browser coverage as pending. Do not run make test-all, E2E, screenshots or resource profiling without explicit approval.

## Interfaces and ownership

Follow the shared contract in README.md in this directory. This change owns only its named subsystem; update direct consumers and fixtures together. Critical seed access is restricted to the documented identity boundary. Fixed frames use positional MessagePack arrays.

## Persistence, lifecycle and failures

Formats are greenfield; no fallback readers, migration conversion, or automatic data destruction. Every asynchronous owner handles cancellation, stale completion and disposal, and releases owned buffers/resources on success and failure. Accepted server mutations survive cancellation; reconcile exact records rather than silently rebasing. Invalid input must not publish state or lower trusted checkpoints.

## Exclusions

No multi-library support, termination, device permissions, rotation, data backups, or compatibility. No E2E/screenshots/profiling without explicit approval.

## Acceptance and commit

Affected non-browser test union, clean builds and final diff/dependency/authority-boundary audit.

Implement as one cohesive commit after affected checks pass and builds are warning-free.

## Results — 2026-10-22, at `d768968`

Node 22.23.3 (`client/.nvmrc`), Cargo 1.99.0. Run sequentially.

| Check | Result |
| --- | --- |
| `make -C client test` (unit tests, Biome, TypeScript, svelte-check) | 183/183 pass; 0 errors, 0 warnings |
| `make client` | Builds without warnings |
| `make test-build` (web and unpacked extension contents) | 3/3 pass |
| `cargo test` | All pass (one `#[ignore]` subprocess fixture, exercised by its parent test) |
| `make format-check`, `cargo clippy --all-targets --all-features -D warnings` | Clean |
| `make test-db` (isolated PostgreSQL, fresh `001_init.sql` baseline) | 53 + 15 + 5 + 3 pass |

The database suite covers fresh initialization and re-initialization of a
registered library, changed-migration rejection, atomic and idempotent
registration that preserves invitations, isolated registration admission with no
nonce writes, unknown keys that never read bodies or spend nonces, fixed-authority
paging, concurrent appends, quotas and purge. Shared-seed vectors are checked in
both languages.

Audit: no `hpke`, epoch, enrollment, recovery-principal or rotation code or
dependency remains. Only `stores/session.ts` and `services/pairing-crypto.ts`
import `services/library-identity.ts`.

**Pending explicit approval:** Firefox/Chromium E2E (`client/e2e/`, including
the updated fixtures and the new `backup.spec.ts`), screenshot review, and
resource profiling. These have not been run.
