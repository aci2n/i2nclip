# Implementation plan: item 43 — Complete the light CSS reset

## Goal and scope

Zero default margins/padding for the HTML elements the app uses, then declare meaningful spacing in their owning components. Keep existing theme/control typography and padding. Follow [the implementation guide](implementation-guide.md).

## Code map and historical change

- `client/src/app.css`: currently zeroes body/h2/p/ul margins, but list padding and several UA defaults remain.
- Commit `18f380b` (“Consistent margins”) is already in repository history. Review it with `git show 18f380b -- client/src/app.css client/src/lib/components/ManageLibraries.svelte client/src/lib/components/Pairing.svelte`; do not cherry-pick/revert/recommit it.
- `ManageLibraries.svelte`: fieldset/legend own their spacing and border treatment.
- `Uploads.svelte`: progress list suppresses markers; failed uploads need indentation and markers.
- `RecoveryImport.svelte`: recovery preview `<ul>` currently relies on default indentation; add explicit component-owned indentation.
- Other headings/paragraphs/lists should be inventoried with `rg`, including view styles and dialogs.

## Implementation sequence

1. Inventory used headings, paragraphs, lists, fieldsets/legends and any additional default-spaced semantic elements before changing the reset. Record their current intended spacing: stacks/fields provide gaps, actionable list markers convey information.
2. Consolidate a small explicit reset selector set in app.css, e.g. body, h1–h6, p, ul, ol, fieldset and legend with `margin: 0; padding: 0`. Include other actually used semantic elements only when justified. Do not use `* { margin: 0; padding: 0 }`: it would also erase shared input/select/button padding. Preserve existing box-sizing and theme typography rules.
3. Keep typography/color separate from the reset: the current h2 font size and p muted color remain base styles. Keep `[hidden]` behavior, focus outlines, control padding and native disclosure marker behavior.
4. Restore list indentation with component `padding-inline-start: 1.5rem` and explicit marker treatment wherever needed, especially recovery preview and upload failures. Progress lists retain `list-style: none` and zero indentation. Do not globally hide list markers.
5. Keep fieldset min inline size/border/legend spacing in its component. Preserve accessibility and native control layout; no global border removal or `appearance: none` for all controls.
6. Audit each affected component for spacing previously supplied by paragraph/heading margins. Use existing `.stack`/`.field` gaps or a local style; avoid stacking a new margin on a container's existing gap. Follow the project's rem spacing scale.
7. Fix selectors/layout at the owning component, not global descendant selectors reaching into a particular card/settings panel. Modern layer/nesting organization is item 46; do not make that broader rewrite here.

## Acceptance and verification

- Used reset elements have zero UA margin/padding; input/select/button padding and focus style remain usable.
- Recovery/failure lists are readable with explicit indentation/markers; progress lists retain their grid/no-marker style.
- Paragraph/headings keep separation via parent gaps; fieldset/legend do not overflow narrow screens.
- Inspect Settings/setup/pairing, recovery review, upload failures, About and mixed-media library views with long names/errors, light/dark and 320/360 px.

Run client checker/lint and extension build. Reuse the relevant existing settings/setup/library/upload/About browser scenarios and `shot()` fixtures; inspect actual Firefox images. Do not add CSS-value unit tests that merely restate the declarations.

## Implementation notes

Reviewed `18f380b` without replaying it. Consolidated zero margin/padding for body, headings, paragraphs, lists, definition lists, fieldsets and legends; control padding, typography and focus remain separate. Recovery preview and failed uploads own explicit logical list indentation; recovery rows own a compact gap. Existing component stacks/fields supply paragraph/heading spacing and fieldsets retain local borders/minimum size. Combined visual/check verification deferred until the end of TODOs 37–46.

Combined checks completed: client tests/checker/lint, web/extension builds and all 64 browser scenarios are covered in [the verification report](verification-37-46.md). Actual narrow Firefox screenshots were inspected.
