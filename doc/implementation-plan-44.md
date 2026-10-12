# Implementation plan: item 44 — Eliminate duplicate Pairing IDs

## Goal and ID decisions

Every Pairing instance has unique HTML IDs and matching label/ARIA references, including instances inside closed disclosures or hidden setup tabs. Preserve stable selectors where useful. Follow [the implementation guide](implementation-guide.md).

CSS scoping does not scope document IDs. Use an explicit caller-supplied `idPrefix` rather than a random prefix or a shared default. Configured Pairing can use `pairing` to preserve existing `#pairing-settings`/`#pairing-code`; additional setup uses `setup-pairing`, and first-library setup uses `initial-pairing`. Each caller must give its actual instance a distinct prefix.

## Code map

- `components/Pairing.svelte`: wrapper, start/receive form/input, code/verification output, approve/mismatch/status IDs and label references.
- `views/Settings.svelte`: standalone configured Pairing and embedded Setup callers.
- `components/Setup.svelte`: embedded Pairing; hidden panel remains mounted today.
- `e2e/pairing.spec.js`, `multi-library.spec.js`, `setup.spec.js`, `settings.spec.js`: global `#pairing-*` and `[data-embedded]` selectors.
- `Settings.svelte` and `Setup.svelte` also reuse `id="status"`; a configured status and additional-setup error can coexist. The document-wide uniqueness assertion must cover that scenario too.

## Implementation sequence

1. Reproduce simultaneous standalone and embedded rendering by opening Add Library's Pair tab while configured Pairing exists. Also inspect DOM with Add Library closed and a hidden Pair panel: hidden nodes count for uniqueness.
2. Add required `idPrefix`; define a local ID helper such as `id(suffix) => idPrefix + "-" + suffix`. Apply it consistently to every retained ID and every `for`/`aria-labelledby`/`aria-controls` reference. Preserve configured suffixes so its old IDs stay stable; update embedded test selectors explicitly.
3. Remove IDs that have no accessibility or test purpose and use local classes for styles. The component can use `class:embedded`/a named modifier class for spacing instead of the existing `data-embedded` styling hack. Do not change pairing workflows or store props; their ownership is item 45.
4. Audit the simultaneously mounted Settings/Setup feedback IDs. Keep a root status ID if needed, but give setup feedback a unique instance ID or use a scoped semantic/class selector. Update affected fixture selectors; never fix a duplicate with `.first()`.
5. If additional duplicate Setup IDs are exposed by the current rendering after 36, apply its first/additional instance prefix to those conflicting fields/tab panels and their references. Adapt `stores/dom.js::selectTab()` if tab IDs change, using the actual rendered tab descriptors/scoped element lookup rather than its current `#${next}-tab` assumption. Avoid renaming unrelated unique IDs.
6. Scope E2E locators to the correct pairing container and use semantic actions/labels within it. A full-page selector for the sender must not accidentally target a hidden embedded receiver. Remove test reliance on `data-embedded` once container prefixes provide isolation.

## Acceptance and verification

- `document.querySelectorAll('[id]')` has no duplicate nonempty values in first-library, configured, Add Library open/closed, active sender and active receiver states.
- Every label's `for` points to its intended input/output; split each ARIA IDREF list on whitespace and verify every referenced target exists. Hidden panel references may resolve to hidden nodes; that is fine, duplicate targets are not.
- Test both current feedback messages at once (configured message plus setup failure); uniqueness still holds.
- Keyboard activation, verification/approval/mismatch/cancel and sender/receiver status target the intended instance.
- Preserve useful configured selectors; new additional/initial prefixes are deterministic.

Put the document-ID/reference assertion in an existing E2E helper or focused settings/pairing test and exercise Firefox/Chromium. Run checker/lint/extension build. Inspect Pairing screenshots if replacing the spacing modifier changes the rendered layout.

## Implementation notes

List retained ID prefix/suffix conventions, feedback/tab fixes, updated selectors and tested simultaneous states. Item 45 must retain this interface.
