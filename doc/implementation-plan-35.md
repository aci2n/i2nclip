# Implementation plan: item 35 — Select an existing library after duplicate pairing

## Goal

When a pairing receiver presents an identity already saved in this vault for the same server, finish by selecting that saved library instead of surfacing “This library is already saved. Select its existing entry.”

## Changes

- Trace the receiver path from `createPairing.receive` through `session.importPairing`, catalog persistence, and application library selection.
- Detect the duplicate using the same public-key and server-origin comparison as repository validation. Do not treat a key on another server as the same library.
- Return a structured duplicate result containing the existing library ID from the service boundary; do not expose private key material or weaken repository validation.
- Have the application select the existing catalog entry, close the temporary setup, and show a concise success/status message. Complete or cancel the pairing relay cleanly so a duplicate does not leave an active room.
- Keep ordinary new-library pairing behavior unchanged.

## Acceptance

- Add a regression for pairing a library already present in the current vault: the existing entry becomes selected, no duplicate record is written, and no duplicate error remains.
- Verify pairing a new library still saves and selects it, and a same key on a different server is not mistaken for a duplicate.
- Verify relay cleanup and cancellation behavior; run pairing unit tests and focused real-API browser tests.
