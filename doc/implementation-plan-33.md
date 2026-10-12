# Implementation plan: item 33 — Strict JavaScript lint rules

## Goal and scope

Enable all applicable lint rules in the pinned Biome version across the existing client lint scope. Keep the npm project, runtime behavior and protocol unchanged. Follow [the implementation guide](implementation-guide.md).

## Code map and current work

- `client/package.json`: `lint` currently runs `biome lint src cli smoke tests e2e *.config.js`; `format:check` is a separate command.
- `client/package-lock.json` and `client/node_modules/@biomejs/biome/configuration_schema.json`: resolve the installed version and accepted configuration locally.
- `client/biome.json` currently uses the recommended preset. Another agent was working on strict lint during this review, including a temporary JSONC configuration. Re-read `git status` and the actual config before proceeding; preserve any ongoing changes instead of generating a competing configuration.

## Implementation sequence

1. Establish the actual resolved Biome version, config filename and current lint coverage. Keep the dependency version unless a specific unsupported rule requires a separately justified upgrade. Ensure only one authoritative Biome config remains.
2. Enable all supported applicable rules, including non-recommended/nursery rules where the installed schema permits them. Use the installed schema to verify syntax; do not assume that old Biome `all`/`recommended` examples match this version. Make findings fail the command, rather than leaving stricter rules as nonfatal warnings.
3. Triage findings by rule before editing. Apply safe mechanical fixes in bounded groups. Inspect their diff, then repair behavioral findings by hand. Do not apply unrestricted unsafe fixes to protocol, concurrency or resource-management code.
4. Preserve intentional patterns: sequential awaits in upload and identity workflows, Node built-ins/environment access in CLI/tests/configs, Svelte's compiler-checked bindings, and browser API isolation. Restrict exceptions to the smallest useful file/pattern or rule. Explain each exception beside it; do not disable a whole group to reduce the findings count.
5. Keep formatting separate from this lint change. A JSONC config is acceptable for explanatory comments. Avoid replacing a small rule exception with unrelated architectural refactors or indiscriminate formatting of the entire client.
6. Re-run lint after each substantial fix group. Check that `src/extension`, reusable code, CLI, smoke, unit tests, E2E and Vite/Playwright config files remain included. Generated `dist`, dependencies and fixed crypto vectors retain their intended exclusions.

## Acceptance and verification

- `npm run lint --prefix client` exits zero, with stricter rules active and no broad suppression hiding source directories.
- Demonstrate a non-recommended rule using an existing finding or a temporary fixture placed in the lint scope, then remove that fixture. Do not add a permanent lint-test framework.
- Review all new suppressions and their reasons. The browser scope still rejects Node-only imports; Node scopes still lint their other rules.
- Because rule fixes may touch many runtime files, run `make test-client` and `make extension`; run focused browser regressions if Svelte markup or behavior changed. Protocol changes must still pass existing shared-vector tests. No Rust change is required merely for a JavaScript lint configuration.

## Implementation notes

Record the resolved version, selected preset/rule levels, exceptions, representative enforcement evidence and checks after the ongoing implementation settles.
