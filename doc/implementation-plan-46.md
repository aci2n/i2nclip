# Implementation plan: item 46 — Apply modern CSS features where useful

## Goal and boundaries

Use native nesting where it groups related selectors clearly, and a small cascade-layer structure for global styles. Preserve rendered behavior, themes, scoped component styles and accessibility. Follow [the implementation guide](implementation-guide.md) after 43's reset and 44/45's Pairing changes settle.

## Code map and cascade decisions

- `client/src/app.css`: theme tokens, reset, typography, shared controls/layout primitives and `[hidden]` invariant.
- `components/Pairing.svelte`: already contains native nesting; do not rewrite it just to count nesting changes.
- Other Svelte `<style>` blocks remain component scoped and **unlayered**. Normal unlayered component declarations outrank normal global layer declarations, regardless of specificity. That is the intended precedence, but existing styles that relied on global specificity must be reviewed.
- `client/vite*.config.js`: web/extension builds disable minification. Do not change this to adopt CSS features.
- Check the stricter Biome configuration from item 33 for `useLayeredStyles`. Keep a documented scoped-style exception if that rule would force every Svelte component into layers; do not weaken unrelated lint rules.

## Implementation sequence

1. Inventory global rules and component selector groups; choose a few changes with a clear readability benefit. Record the chosen scope before changing it. Do not mechanically nest the entire stylesheet.
2. Declare the global layer order once at the beginning of app.css: `@layer reset, base, controls, layout;`. Put the reset/box sizing in reset, theme tokens and both color schemes/typography in base, inputs/buttons/focus treatment in controls, and stacks/fields/bars/panels/feedback primitives in layout. Preserve relative source order within each layer.
3. Keep the critical existing `[hidden] { display: none !important; }` outside layers. Review any other `!important` rules individually: important declaration layer ordering reverses normal ordering, so a mechanical move can change behavior. Do not add more important declarations to repair normal cascade issues.
4. Keep component blocks unlayered. Where layering reveals an unintended override (e.g. local button rule now outranks shared control rule), explicitly decide its owner and fix that component/global primitive narrowly; do not restore behavior with global selectors reaching into components or specificity escalation.
5. Use native `&` nesting for a selector and its states/modifiers/media queries where the compiled selector has the same intended meaning. Separate selectors whose comma list would change specificity; verify class/type/descendant/child combinators explicitly. Keep depth at one or two clear relationships, not long descendant chains. Retain semantically named classes.
6. Preserve light/dark tokens, form disabled/focus-visible/placeholder states, warning/error colors, wrapping, hidden tabs/dialogs and responsive layouts. No theme redesign or extra breakpoints are part of this item.
7. Build web and extension and inspect emitted CSS for global layer order and scoped selectors. If the installed Svelte/Vite pipeline emits a warning or unsupported nesting, use the established flat selector for that case rather than changing toolchains. Re-enable a scoped lint rule only when the change actually makes its requirements appropriate.

## Acceptance and verification

- Web/extension output has one consistent global layer order; component styles remain scoped/unlayered and builds/checker have no CSS warnings.
- Computed styles still produce intended theme/control/focus/hidden behavior. Tab panels with `hidden` remain absent even if their local class uses grid/flex.
- Before/after Firefox screenshots show unchanged library cards, Settings, setup, pairing, uploads, recovery and About at normal and 320/360 px widths in both themes; use realistic media, long names and errors.
- Inspect Chromium behavior for native nesting/layers through the relevant browser scenarios too. Keep no-minification build settings and avoid adding a CSS framework/preprocessor.

Run client checks and `make web`/`make extension` once after the stylesheet changes. Reuse representative existing E2E/shot helpers; do not run database/profile/live-smoke suites just for stylesheet organization.

## Implementation notes

Introduced global order `reset, base, controls, layout`: semantic/box reset, theme/typography, shared controls/focus, then layout/feedback primitives. Scoped component blocks remain unlayered. Native nesting groups button modifiers, container children and Pairing children; unrelated selectors stay flat. Restored the unlayered important hidden invariant after reviewing the existing FIXME: normal global layers cannot override component grid/flex semantics. No other important declarations or minification/toolchain changes. Current Biome config has no layered-styles restriction to weaken. Compiled CSS, cascade and representative screenshots will be inspected during combined end-of-batch verification.

Combined checks completed: client tests/checker/lint, web/extension builds and all 64 browser scenarios are covered in [the verification report](verification-37-46.md). Actual narrow Firefox screenshots were inspected.
