# Implementation plan: item 32 — Sequential default library names

## Goal

New library setup starts with the next unused name in the “Personal N” sequence. The user can still edit the suggested name before creating the library.

## Changes

- Add one small helper that scans the current saved catalog for names matching “Personal” or “Personal N”. Compare names case-insensitively and treat bare “Personal” as number 1.
- Return the lowest unused positive number, formatted as “Personal N”. This handles renamed/deleted entries without reusing an existing number.
- Use the helper when initializing a new library setup draft, including the first library and Add Library. Do not replace the current saved library's displayed name when switching libraries.
- Keep the generated name in the existing editable draft; do not add a server API or persistence field.

## Acceptance

- Cover an empty catalog, bare “Personal”, numbered names, gaps, case variants, and a user-edited name.
- Verify both first-library setup and Add Library show the generated suggestion, and that the saved name matches the submitted draft.
- Run client tests, Svelte checks, and the focused settings browser scenario.
