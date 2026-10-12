# Implementation plan: item 44 — Eliminate duplicate Pairing IDs

## Goal

Ensure every Pairing component instance renders unique document IDs while keeping useful, stable selectors for browser tests.

## Changes

- Confirm all Pairing instances and test selectors; the component is rendered both as a configured-library panel and inside setup.
- Add a caller-supplied instance prefix for IDs used by Pairing, including label references and ARIA relationships. Give configured and embedded instances distinct prefixes.
- Keep IDs that tests need stable and update tests to target the correct instance. Remove IDs used only for styling or interaction where a class or semantic selector is clearer.
- Do not rely on Svelte CSS scoping to make HTML IDs unique; component styles do not scope DOM IDs.

## Acceptance

- Add a browser assertion that all rendered IDs are unique and every `for`, `aria-labelledby`, and `aria-controls` reference resolves.
- Cover simultaneous configured and embedded Pairing instances, including hidden setup panels; run pairing/settings browser tests in Firefox and Chromium.
