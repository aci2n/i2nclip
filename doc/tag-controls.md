# Tag control layout and scrolling

## Goal and scope

Keep desktop chips compact, align Clear within the search field, match media-card
tag/disclosure sizing, and make autocomplete scrollable. Deliver sizing/alignment
and scrolling as two separate commits. Keep the custom list, immediate selection,
10-result cap, ordinary Tab/arrow/Enter/Escape behavior and no HTML IDs. No native
datalist, Ctrl+N/P handling, dependencies, API or database changes.

## Interfaces, ownership and lifecycle

SearchForm owns its layout; TagEditor owns chip/disclosure styling; TagInput owns
input and suggestion presentation. Keep all styles component-local and existing
ordinary props/callbacks. Desktop search chips have a 2rem minimum height with
smaller removal controls and no margins; the baseline search field remains 3rem.
Center Clear vertically across wrapped rows, anchored right. Card chips and
disclosure share height, line-height and padding; widths follow their text.
Preserve mobile/coarse-pointer controls of at least 44px and long-label wrapping.

The suggestion list gets overflow-y:auto, max-height:min(15rem,40dvh), and
overscroll-behavior:contain. Focused suggestions must scroll into view using
ordinary browser focus scrolling; add no selection state or keyboard shortcuts.
There is no new persistence, resource ownership, async workflow or cancellation.
Existing failed drafts, cancellation and session cleanup remain unchanged.

## Acceptance

Verify desktop chip containment, Clear centering for single/wrapped rows, matching
card chip/disclosure heights, and mobile touch targets/overflow. Exercise ten real
catalog suggestions with wheel, Tab and arrow scrolling, last-result selection
and Escape in search and editing. Inspect Firefox screenshots at desktop and
320/360px in both themes, including long tags. Run client checks, relevant
Firefox/Chromium tests and warning-free builds before committing.
