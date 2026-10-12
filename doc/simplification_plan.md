After experimenting with increasingly complex client architectures, I've come to the conclusion that the project is not maintainable in its current state.

The simplification plan has the following goals:
- Phase 1: fully remove web extension support: a future web extension could just be a bridge to the web app, instead of duplicating the logic as it does today. Investment in the extension is futile at this point. Remove all extension specific code.

- Phase 2: in the same line, fully remove the node CLI and smoke tests.

- Phase 3: replace the SharedWorker architecture and all its state management. Clients will access the server directly through the store.

- Phase 4: singleton library architecture. Multiple libraries is too much complexity for a fictional requirement.

- Phase 5: clients own their state, no cross-tab synchronization. The app rejects to open in a second tab. No locking needed to access the client database.

- Phase 6: Minimal persistent client state. No upload job persistence. Only store the essential data in the database.

- Phase 7: localStorage over IndexedDB for persistent data.

- Phase 8: Frontend component refactor. Svelte files in components/ must NOT access the store under any circumstances. Each component should have a single isolated responsibility and only interface through props and events. State management is exclusively managed by views. Using `id` attribute in HTML elements is FORBIDDEN.

- Phase 9: Backend cleanup: remove obsolete endpoints following the client simplification, like the authorized register API.

- Phase 10: Test cleanup. Preserve the minimal suite of unit and E2E tests that get the job done. Test quality is not negotiable.

- Phase 11: Audit the refactor. Ensure documentation does not reference obsolete architecture.

- Phase 12: Remove library name, no longer needed for single-library clients.

- Phase 13: Document in AGENTS.md that agents must strictly respect the guidelines followed during this refactor. Emphasis on doing the minimal thing that achieves the goal, component isolation, etc. Demand that future changes require highly detailed specifications like this one.

- Phase 14: Clean up obsolete/excessive package.json commands, makefile targets, outdated documentation files.

- Phase 15: Review project test pipeline. Ensure that every test is independent and isolated, does not depend on shared port publications unless strictly necessary and can be executed successfully from a fresh clone of the project. Tests that cannot run are dead tests and should be removed.

- Phase 16: Review the final result and suggest further improvements.


Overarching guidelines:
- code should be well organized, separated, and designed to be read and maintained by humans
- do the minimal thing that achieves the stated goal
- ask for clarification on ambiguous points
- run tests at the end, focus on refactoring the code first, if the code builds you can commit
- do small frequent commits
- assume the project is greenfield, has no live users and do not worry about data/protocol migrations
