# Remaining work

Work through these items in priority order. Items marked **Plan first** need a short design decision before implementation. See [the audit report](audit-2026-10-10.md) and [completed audit follow-ups](todo-completed.md) for background and prior work.

1. [ ] **31 — Plan first:** Master password and single vault.
2. [ ] **32:** Default new library names to “Personal N” (sequential number or random number; choose a sensible approach).
3. [ ] **33:** Add strict rules to the JavaScript linter.
4. [ ] **35:** Fix pairing in the same page: “This library is already saved. Select its existing entry.” Investigate why the existing entry cannot be selected.
5. [ ] **36:** Simplify Add Library setup. Keep setup state in the client; remove resumable setup, Cancel Setup, and discard-pending-creation flows. On registration failure, show an error and commit only identities whose registration succeeds.
6. [ ] **34 — Plan first:** Image compression before upload. Assess browser support and image formats; consider WebP conversion, quality controls, and a user setting.
7. [ ] **37:** Move “Forget this library” to the bottom of the page, above “Reset this browser,” using warning text color.
8. [ ] **38:** Remove server URL editing from Manage Library; only OTC and Pair should accept server URLs.
9. [ ] **39:** Keep each completed upload job visible until automatic cleanup after N seconds; do not replace the jobs immediately with a summary.
10. [ ] **40:** Update tags without reloading the library page.
11. [ ] **41:** Insert uploaded files at the beginning of the current library page.
12. [ ] **42:** Hide the Authorize tab when no authorizing libraries are available.
13. [ ] **43:** Add a light CSS reset in `app.css`, setting relevant elements' margins and padding to zero. Prefer zero default paragraph margins and component-owned spacing. Review the existing `<h2>`, `<p>`, and `<ul>` changes and commit `18f380b`.
14. [ ] **44:** Investigate duplicate element IDs in pairing-settings and whether component IDs can be scoped in Svelte. IDs in views are acceptable when useful for tests.
15. [ ] **45:** Keep store access in views; start by making Pairing pure and review other components for the same issue.
16. [ ] **46:** Use modern CSS features, including nesting and layers, where they fit.

## Deferred

- **15:** Allow multiple pairing sessions for the same owner when the public key is shared.
- **16:** Persist pairing state in the database for stateless servers.
- **24:** Consider a shared, service-owned notification stack with client-selected placement and dismiss timing.
