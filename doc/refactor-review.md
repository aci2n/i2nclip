# Final simplification review — phases 12–16

## Result

The single library has no name field, rename workflow, or name validation. Creation takes only the server URL and invitation; saved and recovered identities contain only the server URL and private identity document. Media filenames remain part of encrypted metadata.

`AGENTS.md` now requires detailed written specifications, minimal changes, isolated component responsibilities, explicit ownership, and meaningful acceptance checks. Tooling has one web build and one packaging command. Completed storage plans, duplicate historical reviews, and stale command documentation were removed; current guidance lives in the client ownership and test pipeline documents.

Test listeners bind loopback port 0 atomically. Scenarios use separate databases and browser contexts, run prebuilt helpers directly, and own process cleanup. Cargo target locations come from metadata, inherited production database-file settings are cleared, and screenshots have per-test output paths. Rust fixture guards clean up even after assertion panics. Four default Rust test cases and one-connection inspection pools keep shared PostgreSQL resources bounded while race tests retain their internal concurrency.

## Verification

Verification used an independently cloned checkout that initially had no node_modules, client dist, or Rust target directory, with Node 22.23.3 from `.nvmrc`. Its own build outputs were moved from limited tmpfs scratch space to an ignored disk-backed directory during compilation. It did not use the working checkout's project artifacts.

| Check | Result |
| --- | --- |
| Complete `make test-all` pipeline | Passed in the independent clone |
| Client unit tests | 63 passed |
| Svelte checker | Zero errors/warnings |
| Rust unit/database tests | 45 passed |
| Rust configuration tests | 3 passed |
| Rust API tests | 25 passed |
| Firefox/Chromium E2E | 12 passed |
| Lint and formatting | Passed |
| Web ZIP preparation and contents | Passed |
| Optional resource profile | Passed with port 8080 occupied by an unrelated placeholder; zero requests reached that placeholder |

Actual Firefox screenshots were inspected after the UI change, including narrow layouts, both themes, realistic media shapes, audio/video/files, long names, and adjacent settings errors. Current commands and preparation are specified in [test-pipeline.md](test-pipeline.md).

## Suggested next specifications

| Priority | Finding | Smallest useful follow-up |
| --- | --- | --- |
| First | `session.create` registers a candidate before saving it locally. An ambiguous registration response or failed local write can consume an invitation while leaving the client unconfigured. | Specify an in-memory candidate retained for retry, prove registration with the existing signed ping, and clear it on lock/reset/server changes. Cover lost replies and storage failures without adding persistent workflow jobs. |
| Next | Download admission, response lifetime, and production shutdown are unbounded in `src/media.rs` and `src/lib.rs`. A held response retains bytes and capacity. | Use [the existing deadline proposal](transfer-shutdown-proposal.md) as the specification. Cover saturation, abandoned/unpolled bodies, resource release, and bounded shutdown. |
| After measurement | `api.readBody` collects chunks and then builds another contiguous byte array before content decryption; server transfer profiles also show a large memory peak relative to payload size. | Measure maximum-size browser downloads and server buffer allocations, then reduce avoidable copies only where the measurements justify it. Preserve hash verification before decryption and cancellation/resource ownership. |

These are review recommendations. Each requires its own detailed specification before implementation. The current refactor keeps media encryption, signatures, metadata AAD, and content-hash verification intact.
