# Library toolbar and file viewer header

Change specification from the 2026-10-22 visual review. Frontend only.

## Goal

The library actions stay on the search field's row, and the file viewer has no
separate row for Lock.

## Changes

- **Search toolbar.** `LibrarySearch` contained both the search form and the
  tag suggestion chips. The toolbar bottom-aligned Refresh and Upload with that
  whole block, so the buttons sat beside the last row of suggestions, and at
  narrow widths they wrapped below all of them. `LibrarySearch` now renders only
  the form. A new `TagSuggestions` component renders the chips, and `Library`
  places it below the toolbar. Its `fieldset` keeps the "Tag suggestions"
  label.
- **Viewer header.** On `/media`, `Application` rendered its header with only the
  Lock button, which added a whole row above the viewer's own header.
  `Application` now defines Lock once as a snippet. While a valid file route
  is open in an unlocked library, `Application` skips its header and passes
  the snippet as the `actions` prop to `Media`, and through it to `MediaViewer`.
  `MediaViewer` renders it after Download. Session notices still render. Setup,
  loading and invalid-link states on `/media` keep the existing header.

## Exclusions

No store, routing or behavior change. Lock keeps its label, icon and handler.
No new tokens or shared classes.

## Acceptance

`make -C client test` and `make client` pass without warnings. Firefox
screenshots show Refresh and Upload on the search field's row at desktop width
with suggestions present, and Lock in the viewer header row at 1100 and 320 px
in both themes.
