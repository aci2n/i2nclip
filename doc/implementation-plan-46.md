# Implementation plan: item 46 — Apply modern CSS features where useful

## Goal

Use CSS nesting and cascade layers where they improve readability or make global style precedence easier to maintain, while retaining component-scoped styles.

## Changes

- Inventory `app.css` and Svelte component styles for repeated selector groups and current nested rules.
- Group related selectors with native CSS nesting when the relationship is clear; avoid nesting that hides long descendant chains or changes specificity unexpectedly.
- Define a small global layer order for reset, base/theme, and shared primitives in `app.css`. Keep Svelte component rules scoped and unlayered unless the build proves a layered component strategy is needed.
- Convert only existing styles with a clear readability or cascade benefit; do not mechanically rewrite every selector.
- Verify compiled web and extension CSS preserves the intended ordering in both themes.

## Acceptance

- Build web and extension targets and run the Svelte checker without CSS warnings.
- Inspect representative settings, library, pairing, upload, and media-card views at narrow widths in light and dark themes.
- Confirm cascade layers do not let component styles fall behind global rules and that nesting changes no rendered behavior.
