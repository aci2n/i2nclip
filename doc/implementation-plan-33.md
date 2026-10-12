# Implementation plan: item 33 — Strict JavaScript lint rules

## Goal

Strengthen the existing Biome lint configuration so all applicable lint rules in the pinned Biome version are enforced consistently across the current lint command's client code and tests.

## Changes

- Keep Biome as the linter; the current client project already uses Biome with recommended rules.
- Enable all applicable lint rules supported by the pinned version. Do not enable formatter or assist actions as lint rules.
- Run lint, fix genuine findings, and add narrow per-rule exceptions only where a rule conflicts with an intentional project pattern. Add a short reason beside each exception.
- Keep the current `npm run lint` coverage and ensure newly added JavaScript remains covered.

## Acceptance

- A clean `npm run lint --prefix client` passes with the stricter configuration.
- Add a configuration-level check or representative fixture if needed to prove a non-recommended rule is active; avoid introducing a lint-test framework solely for this item.
- Confirm no broad file, directory, or rule-group suppression hides findings.
