# Storage query and formatting cleanup

Change specification for audit findings D4 and D5 ([audit](audit-2026-10-22.md)),
extended by request to make formatting consistent across the Rust code.

## Goal

Readers should meet one formatting style. Many SQL queries were dense one-line
strings whose long statements rustfmt silently left unformatted, and several
comments still described per-device membership and allow-lists that no longer
exist.

## Changes

- Every query follows the SQL rule now in AGENTS.md. Statements rustfmt had
  skipped are split so the formatter applies; raw SQL aligns with its delimiters,
  matching the existing `db.rs` style.
- `db/chain.rs` shares one `find_library` lookup (with `LIBRARY_BY_KEY`) between
  `lock_library` (`FOR UPDATE`) and `block_page`; both revalidate the stored
  genesis as before.
- Stale comments in `auth.rs`, `crypto.rs`, `chain.rs`, `db.rs` and `db/chain.rs`
  describe single-library registration. Over-wide doc comments, clap attributes,
  a maintenance log macro and a timeout assertion are wrapped or restructured.
- AGENTS.md gains the formatting and SQL rules.

## Exclusions

No query semantics, schema, API or behavior change. The `FIXME` in
`pairing.rs` is left for its author. Long test names, one error-message
literal and doc examples remain over 100 columns.

## Acceptance

A whitespace-insensitive comparison shows SQL text unchanged. `cargo fmt
--check`, clippy with `-D warnings`, `cargo test --lib`, and `make test-db`
(isolated PostgreSQL container) pass.
