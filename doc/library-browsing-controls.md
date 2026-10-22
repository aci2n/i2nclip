> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# Library browsing controls

## Goal, scope and exclusions

Add a visible Refresh action for both unfiltered and filtered library results,
make tag expansion actions visually distinct from tag chips, and allow selecting
a media-card tag to add it to the immediate AND search. No API, protocol, schema,
dependency, upload, preview-layout, or tag-editing workflow changes.

## Interfaces and ownership

Library passes its existing refresh callback to a toolbar button, disabled while
loading or the session is busy. Refresh reruns the submitted query from page one,
without committing or clearing draft text. Library passes addTag through MediaCard
and TagEditor to an optional TagChip selection callback. The tag label becomes a
keyboard-accessible button with a search-specific accessible name; removal remains
a separate button. Search chips retain their existing presentation. Expansion is
a compact muted text action: “+N more” for the number of tags hidden beyond
the first six, and “Fewer tags” when expanded. It has no underline, arrow or
filled background, and stays grouped to the right of the add button when not
editing, in both visual and keyboard order. Existing mobile touch sizes and
wrapping remain supported.

## Persistence, lifecycle and failures

No new state persistence or resources. The existing library store owns refresh
and tag searches, normalization/deduplication, cancellation, stale-response checks,
pagination reset, session invalidation and errors beside the toolbar. Card tag
selection uses the same immediate search behavior as suggestions, including draft
clearing. Disabled/deleted cards cannot select or remove tags. Disclosure state
remains local presentation state and never changes tags or the query.

## Acceptance checks

Refresh sends an unfiltered request with no tags selected and preserves submitted
filters and unsubmitted text otherwise. Selecting card labels by pointer or
keyboard adds one deduplicated search chip and filters results; removal still
edits metadata separately. Expansion/collapse does not alter search or tags.
Run client checks/tests and a warning-free build, plus relevant Firefox/Chromium
browser tests. Inspect Firefox screenshots in light/dark at desktop and 320/360px
with long tags and realistic media using the existing visual fixtures.

The compact disclosure retains its descriptive accessible name and aria-expanded.
Verify the hidden count, expansion/collapse, adjacent add action and mobile touch
targets; keep editing, cancellation, failure handling and persistence unchanged.
