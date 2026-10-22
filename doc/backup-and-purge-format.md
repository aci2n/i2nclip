# Backup key derivation and singular purge

Audit items A5, C8 and D6. Both change wire formats, so they ship together.
Formats are greenfield: old backups and old purge blocks are not read.

## Goal

1. A backup password is a generated random secret, not a human password, so a
   slow password KDF adds seconds on mobile without adding security. Derive the
   backup key with HKDF and make the password easy to transcribe.
2. `PurgeFiles` carries a sorted ID list, but the client always purges one file.
   Make the operation and its storage effect singular.

## Backup format

- Password: 32 characters from the pairing alphabet
  (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, 5 uniform bits each, 160 bits), displayed
  and copied as eight groups of four joined by `-`.
- Input normalization: uppercase, remove whitespace and `-`; the result must be
  32 alphabet characters, else "Enter the 32-character backup password." before
  any cryptography.
- Key: HKDF-SHA-256 with the normalized password's UTF-8 bytes as input key
  material, an empty salt, info `i2nclip/library-backup/2`, producing an
  AES-256-GCM key. A fresh random password per backup makes a salt unnecessary.
- Frame: `["i2nclip-library-backup", 2, [1, iv, ciphertext]]`, AES-GCM with AAD
  `i2nclip/library-backup/2`. The plaintext credential is unchanged, and the 1 MiB
  cap and canonical re-encoding check stay.
- `passwordSeal`/`passwordOpen` are removed because only backups used them. The
  local master-password seal keeps PBKDF2 (600,000 iterations).

## Purge format

- Operation: `["PurgeFile", file_id]`, replacing `["PurgeFiles", sorted_ids]`.
- Storage effect: `["purge", file_id]`, replacing `["purge", [file_ids]]`.
  `MAX_PURGE_FILES` is removed in Rust and TypeScript.
- Validation is unchanged per file: the file must be deleted and unpurged, the
  block carries exactly that effect, and the server purges exactly one retained
  file and releases its bytes and file count.

## Affected interfaces

- Client: `protocol/password.ts`, `services/library-identity.ts`,
  `protocol/chain.ts`, `protocol/chain-state.ts`, `stores/library.ts`, and their tests.
- Server: `StorageEffect::Purge { file }` in `src/chain.rs`, the purge effect in
  `src/db/chain.rs`, and Rust/PostgreSQL tests.
- `doc/protocol.md` backup and operation sections.

## Exclusions

No memory-hard local KDF, no batch purge UI, and no readers for version-1
backups or list purges.

## Failure cases

A wrong, mistyped or damaged password reports "Wrong password or damaged
encrypted data."; a malformed password is rejected before decryption. A purge
effect with a list, or a purge of a live, missing or already purged file, is
rejected by both client verification and the server.

## Acceptance checks

- Backup round trip; grouped, ungrouped and lowercase passwords open it; a wrong
  password fails; a malformed password fails before decryption; a version-1
  frame is rejected.
- Purge operation and effect encode and decode canonically; list forms are
  rejected; the purge transition still requires a deleted, unpurged file.
- `cargo test --lib`, `make test-db`, `make -C client test`, clippy clean.
