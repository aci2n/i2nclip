# Enforce import conventions

## Goal and scope
Enforce the agreed import grouping, redundant-qualification and unused-import
checks using the existing Rust and Biome tools. No runtime, protocol, persistence,
UI or dependency changes. Apply only mechanical fixes required by these checks.

## Interfaces and ownership
Cargo's unused_qualifications lint warns on redundant names; the existing Clippy
-D warnings command makes violations fail. Both Rust formatting commands pass
imports_granularity=Crate and group_imports=StdExternalCrate through --config,
which the installed stable rustfmt accepts (config-file settings are unstable).
Document the verified formatter toolchain instead of introducing nightly.
Client npm/Makefile check runs Biome check plus the Svelte checker; fix runs Biome
check --write. Remove separate client lint/format scripts and targets. Root lint
continues to run Clippy and delegates client checking; root formatting check is
Rust-only because Biome formatting/imports are covered by client check. Pre-commit
uses the same fix/check commands. Explicitly enable organizeImports and promote
noUnusedImports to error. Treat all Biome warnings as failures.

## Lifecycle, failure and exclusions
Checks are read-only; fixes mutate source only when explicitly invoked, including
pre-commit's existing auto-fix workflow. No persistent application state, jobs,
resources or cancellation behavior changes. Preserve conditional imports, public
exports and aliases. Keep qualified ambiguous names. Do not add bespoke lint
scripts or a new linter. Architectural ownership remains a review convention.

## Acceptance
Run the configured formatter/fixer and inspect required mechanical edits. Verify
read-only format/check commands and all-target/all-feature Clippy pass without
warnings, client tests/build pass, and Rust tests pass. Use temporary import
fixtures to demonstrate grouping and Biome duplicate/unused detection without
leaving tracked fixtures. Update current command/toolchain documentation and
commit this tooling change separately.
