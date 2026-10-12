# Implementation plan: item 43 — Complete the light CSS reset

## Goal

Give relevant HTML elements zero default margin and padding, with components explicitly owning the spacing they need.

## Changes

- Review the existing `app.css` reset and commit `18f380b`; retain the current zero margins for body, headings, paragraphs, and lists.
- Add a scoped global reset for the remaining relevant elements, including list padding and fieldset defaults, without resetting form-control padding or border-box behavior.
- Restore list indentation, marker style, and any other meaningful default spacing in components that rely on it.
- Keep component-specific spacing in Svelte styles and use shared layout primitives for repeated patterns.

## Acceptance

- Review every current `<ul>`, `<ol>`, `<fieldset>`, heading, and paragraph usage for unintended spacing changes.
- Inspect Firefox screenshots for realistic media, long names, errors, both themes, and 320/360 px widths; run checker, lint, and focused browser scenarios.
