# Master password guidance

Change specification for audit finding A3 ([audit](audit-2026-10-22.md)).
Frontend only.

## Goal

The master password wraps the permanent, unrevocable library seed in IndexedDB
with PBKDF2-SHA256 (600,000 iterations). Anyone who copies the browser profile can
guess offline, so an 8-character password is weak protection. Users should see
how strong their new password is while choosing it.

## Behavior

- `ui/password-strength.ts` exports `passwordStrength(password)` returning
  `"weak"` (fewer than 12 characters), `"fair"` (12–15 characters with fewer than
  three character classes among lowercase, uppercase, digits and other), or
  `"good"` (16 or more characters, or 12–15 with three or more classes).
- `components/PasswordStrength.svelte` shows one line under a new-password field
  when it is non-empty: "Weak. Someone who copies this browser's data could guess
  it. Use 12 or more characters, such as a few unrelated words.", "Fair. A longer
  passphrase is stronger." or "Strong."
- It appears under "Master password" when creating one (`Unlock.svelte`, status
  `new`) and under "New master password" in `PasswordSettings`.

## Exclusions

The enforced minimum stays 8 characters (`storage/session.ts`); no KDF or format
change, no dictionary checks, no blocking of weak passwords.

## Acceptance

Unit tests cover the strength thresholds. `make -C client test` and `make client`
pass without warnings. Visual review is pending explicit approval.
