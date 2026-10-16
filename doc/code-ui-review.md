# Code and UI consistency review

## Goal and review scope

Review client views/components, stores, protocol/media helpers and Rust module
interfaces after the tag changes. Simplify concrete duplication and stale names;
make controls consistent on desktop, narrow screens and coarse pointers. Keep
follow-up code cleanup and visual cleanup in separate commits after the two tag
control commits. Do not redesign flows or add abstractions/dependencies.

## Findings and specified changes

- Catalog labels already sort in the API layer; suggestion filtering should keep
  that order rather than sorting again. Normalize each candidate once.
- Automatic tags lowercased an extension before using its length to slice the
  filename; Unicode lowercase expansion could remove part of the filename.
  Slice using the original extension, then normalize its format spelling.
- Remove the Library view's pass-through clear-search wrapper.
- Rename internal Rust token-text limits and replacement helpers to reflect tag
  JSON/labels, format the catalog SQL consistently and remove a stale rustdoc link.
- Shared ordinary inputs/buttons are shorter than the established 3rem touch
  controls. Set shared mobile/coarse-pointer minimums and input font sizing;
  preserve compact desktop controls and component-owned exceptions.
- Give disclosures consistent touch padding and keep filename editing targets
  at least 3rem on mobile/coarse pointers.
- Media preview controls still use text glyphs and variable button dimensions.
  Use the existing inline SVG style and consistent 3rem square controls, with
  inherited theme text color. Do not change preview/swipe/loading behavior.
- Add admission-screen side gutters and render tag-catalog request errors with
  the same alert/error treatment as other nearby errors.

## Interfaces and lifecycle

API endpoints, payloads, cryptography, migrations, limits, ownership and stored
formats remain unchanged. The tag helper fix affects only future generated tags;
there is no reindex or backfill. Catalog order is owned by API/catalog state;
components still receive plain props/callbacks. Styles stay in owning components,
with ordinary shared control rules in app.css. No persistence, resource or async
workflow changes; preserve cancellation, busy guards and failed drafts.

## Verification

Cover Unicode extension casing with a meaningful unit regression. Run existing
protocol/store/server checks and grouped import lint. Exercise setup/create,
restore/pair, settings disclosures/errors, unlock/admission, media cards and
image/audio/text previews in Firefox and Chromium. Check no overflow, readable
labels, 44px touch targets and nearby feedback at 320/360px and desktop in both
themes, using real media fixtures. Inspect actual Firefox screenshots. Run full
unit, database, browser and web/extension build verification after cleanup.
