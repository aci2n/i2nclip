# Remove public endpoint IP rate limiting

## Goal and scope
Remove the generic registration/health IP limiter and trusted-proxy address
resolution introduced in 58e7bfc. Infrastructure owns generic HTTP abuse limits.
Restore the pre-feature routing, configuration, dependencies, and documentation.

## Interfaces and ownership
Remove I2N_TRUSTED_PROXIES, client_ip and rate_limit modules, and their AppState
fields. Health and registration retain their original handlers and validation.
Keep per-key transfer permits, storage quotas, and existing pairing protections.
Pairing again uses only the TCP peer, ignoring forwarded headers.

## Persistence and lifecycle
No database or client changes. Remove only the generic in-memory rate registry;
existing pairing state retains its lifetime and cleanup behavior.

## Failures and cancellation
Remove generic HTTP 429 rejection for health/registration. Preserve handler body
limits, timeouts, authentication, and cancellation behavior. Pairing retains its
existing failures and attempt budgets; behind Caddy its peer budget is shared.

## Exclusions and acceptance
Do not configure Caddy, Fail2ban, or the VPS in this change. Do not remove pairing
attempt protections. Verify the diff restores the pre-feature implementation,
no removed config/module references remain, Rust tests pass, and formatting and
Clippy checks pass without warnings. Commit as a separate removal change.
