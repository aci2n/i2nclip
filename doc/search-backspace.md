> Historical design note. Chain, credential, storage, and API details are superseded by [blockchain storage](blockchain-storage.md), [offline recovery](library-recovery.md), and [the current protocol](protocol.md).

# Remove the last search tag with Backspace

## Goal and scope

In the focused search input, Backspace with an exactly empty draft removes the
last selected tag and immediately searches the remaining selection. Repeated
presses remove tags in reverse selection order. With no tags it does nothing.
Nonempty input, including whitespace, retains ordinary text deletion behavior.
Forward Delete, tag-editor deletion, new shortcuts and persistence are excluded.

## Interfaces, ownership and lifecycle

TagInput gains an optional onemptybackspace presentation callback. Invoke it
only for Backspace on an empty, enabled, writable input outside text composition.
Prevent the default for that handled key and retain input focus. SearchForm wires
the callback to its existing onremove prop for the final query entry. Tag editors
do not supply the callback. No stores or asynchronous workflows enter components.

The existing library removal/search path owns requests, pagination reset, aborts,
stale-result checks and error reporting. There is no new state or persistence;
session clearing and disposal remain unchanged. Search failures use existing
feedback. Empty-stack Backspace must not start another request.

## Acceptance

Use real-browser tests in Firefox and Chromium to verify last-in-first-out
removal, immediate results, input focus, ordinary text deletion, composition
protection, and no request when no tags remain. Retain editor keyboard tests.
Run client checks/build and the full cleanup verification suite before completion.

Verification completed: `make test-all` passed, including the new keyboard test
in both Firefox and Chromium (62 browser cases overall), with zero Svelte
errors/warnings and warning-free builds.
