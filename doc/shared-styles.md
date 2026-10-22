# Shared style tokens and primitives

Change specification for the client styling review of 2026-10-22. Frontend
only.

## Goal

Every view and component draws spacing, sizing, radius, type size, color and
touch-target values from one set of tokens in `client/src/app.css`. A visual
pattern that appears in two or more components is defined once in a shared
layer. Component `<style>` blocks keep only layout that is specific to that
component.

## Current state

`app.css` already has cascade layers (`reset, base, controls, layout`), color
custom properties, `color-scheme: light dark`, and the `.stack`, `.field`,
`.bar` and `.panel` primitives. Component styles are unlayered and override the
layers. Repository findings:

- Only colors are tokens. The radii are 0.25, 0.4, 0.5 and 0.6rem. The font
  sizes are 0.75, 0.85, 0.875, 0.9 and 1.05rem. A fixed `3rem` target appears
  about 20 times. `#000b` (backdrop) and `0 0.25rem 0.75rem #0002` (shadow) are
  hard-coded.
- Eleven components repeat the touch query
  `(max-width: 32rem), (pointer: coarse)` only to enlarge their targets.
  `MediaViewer`, `MediaDialog` and the `Application` nav enlarge targets under
  `(max-width: 32rem)` alone, so coarse pointers on wide screens get small
  targets there.
- These patterns are duplicated:
  - Icon buttons: grid-centred, transparent, 3rem, with a 1rem svg. They appear
    in `TagChip`, `Uploads`, `MediaDialog`, `Application` and `TagEditor`.
  - `.chip`: defined in both `TagChip` and `TagEditor`.
  - The `fieldset` reset: `Library`, `Setup` and `LibrarySearch`.
  - `button[aria-pressed="true"]` outline: `Library` and `Setup`.
  - A wrapping flex row with a gap: `.actions`, `.choices`, `.suggestions` and
    `.scope`, in four or more components.
  - The `dialog` box and `::backdrop`: `AboutDialog` and `MediaDialog`.
- Seven disclosures space their body with a per-component
  `.content`/`.reset { margin-top: 1rem }` on the element after `<summary>`.
  This contradicts the "containers own spacing" rule in `app.css`.
- `.danger` only changes the text color, so it is readable only when combined
  with `.secondary`. All five uses write `class="secondary danger"`.

## Changes

### Tokens (`base` layer, `:root`)

- **Spacing.** `--space-1` .25, `--space-2` .5, `--space-3` .75, `--space-4` 1,
  `--space-6` 1.5, `--space-8` 2 and `--space-12` 3rem. These encode the
  AGENTS.md scale. Compact chip padding stays as literal `.125rem .375rem`
  inside `.chip` only.
- **Radius.** `--radius-sm` .25rem (chips, inline inputs, menus) and `--radius`
  .5rem (controls, panels, dialogs). This replaces 0.4 and 0.6rem.
- **Type.** `--text-xs` .75rem and `--text-sm` .875rem (this replaces 0.85,
  0.875 and 0.9rem). The 1.05rem `h2` size stays in its single base rule.
- **Targets.**
  - `--touch: 3rem` is the minimum touch target.
  - `--target` is the compact target: 2rem by default, and `var(--touch)` under
    `(max-width: 32rem), (pointer: coarse)`.
  - That media query in `app.css` is the only place where targets change size.
- **Effects.** `--backdrop: #000b` and `--shadow: 0 .25rem .75rem #0002`.
- **Colors.** Each color token is declared once with `light-dark(light, dark)`,
  using the current values. This removes the `prefers-color-scheme` block. The
  `:root` text and background colors use the same function.

### Shared primitives

- **`reset`.** `fieldset` also gets `border: 0; min-width: 0`.
- **`controls`.**
  - `button.icon`: grid, centred, `width`/`height: var(--touch)`, padding
    `var(--space-2)`, transparent background, inherited color. Its `svg` is
    1rem.
  - `button[aria-pressed="true"]`: the current accent outline.
  - `.chip`: moved from `TagChip`. Its min-height is `var(--target)`, and
    `font-size` becomes 1rem under the touch query.
  - `.danger`: the complete secondary style with `color: var(--error)`, so the
    class no longer depends on `.secondary`.
  - The existing touch rule for buttons, inputs, selects and summaries uses
    `var(--touch)`.
- **`layout`.**
  - `.cluster`: `display: flex; flex-wrap: wrap; gap: var(--space-2)`.
  - `details > summary + *`: `margin-top: var(--space-4)`.
  - `dialog`: the `AboutDialog` box styles (border, `--radius`, paper,
    inherited color, `calc(100% - 2rem)` max sizes), plus
    `dialog::backdrop { background: var(--backdrop) }`.

### Components and views

- Replace hard-coded spacing, radius, type size, shadow and backdrop values with
  tokens. If a value is not on the scale and has no layout reason, round it to
  the nearest token.
- **Duplicates.** Remove each duplicated rule listed above and use the shared
  primitive:
  - `.cluster` replaces `.actions`, `.choices`, `.suggestions` and `.scope`
    where those rules are only flex, wrap and gap. Remaining properties, such as
    the `.scope` margin, stay local.
  - Remove the per-component `fieldset` resets.
  - Remove the `aria-pressed` rules from `Library` and `Setup`.
  - The chip button in `TagEditor` uses the shared `.chip`.
  - Remove the `.content`/`.reset` margin rules that follow `<summary>`.
  - Change `class="secondary danger"` to `class="danger"`.
  - Remove the dialog box and backdrop rules from `AboutDialog`. `MediaDialog`
    keeps local overrides for its transparent, borderless, full-viewport
    presentation.
- **Icon buttons.** The icon buttons in `Uploads`, `MediaDialog` (arrows and
  close) and `Application` (lock) add `class="icon"`. Their local rules keep
  only placement, background and svg-size differences. The `TagChip` remove
  button keeps local sizing of 1.5rem, or `var(--touch)` on touch.
- **Media queries.**
  - Delete component media queries that only enlarge targets. Express those
    sizes as `var(--target)` or `var(--touch)`.
  - Queries that change layout at narrow widths stay width-only. These are in
    `MediaContent`, `MediaDialog`, `MediaViewer`, `Application` (header and
    nav) and `Unlock`.
  - The `Application` nav links and `MediaViewer` header link use
    `min-height: var(--target)`, so they also grow on coarse pointers.
- `MediaContent`'s `.content` class is its root wrapper, not disclosure
  spacing, and stays.

### Review follow-ups

Firefox screenshots of the first implementation showed three remaining
inconsistencies, fixed in the same shared layers:

- `h3` had the browser default size, larger than the base `h2`; it gets 1rem.
- File inputs kept the native gray picker button. `::file-selector-button`
  shares the control font, border, radius and the secondary colors.
- Search suggestions were `.secondary` buttons with their own compact sizing
  and stayed at 0.875rem on touch, unlike tag chips. They use `.chip`, and
  `.chip` gets `min-width: var(--target)` so one-letter chips meet the touch
  target.

## Exclusions

- No new components, stores, props or markup structure beyond class changes.
- No theme toggle, new colors, palette changes or typography changes other than
  merging the font sizes listed above.
- No CSS framework, preprocessor, PostCSS plugin or dependency.
- No container queries or `@scope`. Svelte already scopes component styles.
- The Firefox extension pages do not import `app.css` and are unchanged.
- HTML IDs stay forbidden. No `id`-based selectors are added.

## Interfaces and ownership

`app.css` owns all tokens and the primitives listed above. Components may read
tokens and use shared classes, but must not redefine tokens or style another
component's elements. No TypeScript or Svelte prop interface changes. There is
no persistence or lifecycle behavior. Theme selection still follows the
operating system through `color-scheme`.

## Failure cases

- `light-dark()` requires Firefox 120 or Chromium 123. These are below the
  versions the Playwright suite installs, and no older browser target is
  declared, so no fallback is added.
- Selectors added to the unlayered `[hidden]` override must not be weakened.
  It stays last and unlayered.
- A shared primitive that reaches into a component it does not style (for
  example `.chip svg`) is a defect. Primitives style only the element that
  carries the class or the native element they name.

## Acceptance

- `grep` over `client/src/lib` finds no `#` color literals, no `rem` radius
  literals and no `(max-width: 32rem), (pointer: coarse)` query.
- Remaining raw `rem` values in component styles are layout dimensions, such as
  max widths, media max sizes and grid minimums.
- No `class="secondary danger"`. No component defines `.chip`, a `fieldset`
  reset, or an `aria-pressed` outline.
- `make -C client test` and `make client` pass without warnings, including the
  Svelte checker and the Biome check.
- E2E selectors that depended on removed classes are updated. These are
  selector edits, not new tests: the change has no behavior to test.
- Firefox screenshots remain pending explicit approval. They must cover Setup,
  Unlock, Library (empty, no-match, mixed media, long names, upload errors),
  Settings with disclosures open, the media dialog and page viewer, and the
  About dialog, in both themes at 320, 360 and desktop widths, plus a
  coarse-pointer desktop width. Check that targets are at least 3rem on touch,
  `.danger` buttons are readable in both themes, and card and chip spacing is
  unchanged apart from the intended rounding.

## Commits

1. Tokens and `light-dark()` colors in `app.css`, with no component changes.
2. Shared primitives in `app.css`, plus removal of the duplicates they replace.
3. Token adoption and target media-query removal across components and views.
