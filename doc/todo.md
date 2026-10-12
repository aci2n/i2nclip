# Remaining work

Work through these items in priority order. Each item links to its implementation plan. See [the audit report](audit-2026-10-10.md) and [completed audit follow-ups](todo-completed.md) for background and prior work.

For implementation, read [the shared implementation guide](implementation-guide.md) and the selected plan. The remaining plans include code maps, concrete decisions, ordered steps and focused acceptance cases. Reconcile each plan with preceding completed changes; implement one item at a time and record verification in its implementation notes.

1. [x] **31:** Client-wide master vault, encrypted app data, shared locking, and separate-password library/vault recovery. Verified 162 client tests, Rust checks, 54 browser scenarios, installed Firefox and package checks. ([design](client-service.md))
2. [x] **32:** Default new library names to “Personal N” (sequential number or random number; choose a sensible approach). ([plan](implementation-plan-32.md))
3. [x] **33:** Add strict rules to the JavaScript linter. ([plan](implementation-plan-33.md))
4. [x] **35:** Fix pairing in the same page: “This library is already saved. Select its existing entry.” Investigate why the existing entry cannot be selected. ([plan](implementation-plan-35.md))
5. [x] **36:** Simplify Add Library setup. Keep setup state in the client; remove resumable setup, Cancel Setup, and discard-pending-creation flows. On registration failure, show an error and commit only identities whose registration succeeds. ([plan](implementation-plan-36.md))
6. [ ] **34:** Image compression before upload. Assess browser support and image formats; consider WebP conversion, quality controls, and a user setting. ([plan](implementation-plan-34.md))
7. [x] **37:** Move “Forget this library” to the bottom of the page, above “Reset this browser,” using warning text color. ([plan](implementation-plan-37.md))
8. [x] **38:** Remove server URL editing from Manage Library; only OTC and Pair should accept server URLs. ([plan](implementation-plan-38.md))
9. [x] **39:** Keep each completed upload job visible until automatic cleanup after N seconds; do not replace the jobs immediately with a summary. ([plan](implementation-plan-39.md))
10. [x] **40:** Update tags without reloading the library page. ([plan](implementation-plan-40.md))
11. [x] **41:** Insert uploaded files into the beginning of the current library page. ([plan](implementation-plan-41.md))
12. [x] **42:** Hide the Authorize tab when no authorizing libraries are available. ([plan](implementation-plan-42.md))
13. [x] **43:** Add a light CSS reset in `app.css`, setting relevant elements' margins and padding to zero. Prefer zero default paragraph margins and component-owned spacing. Review the existing `<h2>`, `<p>`, and `<ul>` changes and commit `18f380b`. ([plan](implementation-plan-43.md))
14. [x] **44:** Investigate duplicate element IDs in pairing-settings and whether component IDs can be scoped in Svelte. IDs in views are acceptable when useful for tests. ([plan](implementation-plan-44.md))
15. [x] **45:** Keep store access in views; start by making Pairing pure and review other components for the same issue. ([plan](implementation-plan-45.md))
16. [x] **46:** Use modern CSS features, including nesting and layers, where they fit. ([plan](implementation-plan-46.md))
17. [ ] **47**: Fix tests in current branch. Avoid using IDs for selectors, prefer classes wherever possible. This makes E2E tests very hard to maintain manually. See TODO in Setup.svelte
18. [ ] **48**: Refactor Svelte views and components. Right now components like Pairing are doing way too much for example by implementing both receiving and sending behavior. Components should have a single responsibility, have no access to stores, no id attributes in elements. Views are the containers for the pure components and propagate store state to the pure components through properties. Setup.svelte is another offender that does too many things branching by conditionals. In general, components should not excessively nest conditionals.

## Deferred

- **15:** Allow multiple pairing sessions for the same owner when the public key is shared.
- **16:** Persist pairing state in the database for stateless servers.
- **24:** Consider a shared, service-owned notification stack with client-selected placement and dismiss timing.
