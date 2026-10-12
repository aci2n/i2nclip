# Implementation plan: item 45 — Make Pairing presentational

## Goal and scope

Pairing consumes ordinary state values and callbacks; views subscribe to stores and own the workflow connection. Keep local input/disclosure state inside Pairing. Follow [the implementation guide](implementation-guide.md), preserving item 44's unique IDs and item 36's temporary setup lifecycle.

Convert Pairing and the minimum Setup pass-through needed for it. Inventory other store-reading components, but record them as later work unless conversion is trivial and directly necessary. This item does not rewrite all component workflow ownership.

## Code map

- `components/Pairing.svelte`: `$session`, `$pairing` subscriptions and calls to pairing methods; local `code`/`open` values.
- `views/Settings.svelte`: has root session/pairing stores and setup facade. It renders standalone Pairing and both Setup variants.
- `components/Setup.svelte`: embeds Pairing and currently derives Pair mode/blocking from its pairing store. It may still read settings/session for its unrelated form in this bounded change.
- `stores/pairing.js`: command adapter/subscription/error handling remains the workflow owner. `stores/setup.js` exposes temporary setup pairing/session after 36.
- Other candidates: Uploads, MediaCard, RecoveryImport, RecoveryExport, VaultSettings and ContextDestination. RecoveryImport constructs a store; the others vary between subscriptions and workflow calls. Verify current code before recording the inventory.

## Proposed component contract

Pass a plain `state` snapshot containing `active`, `code`, `verificationCode`, `approval`, `server`, `remaining`, `status`, `error`; explicit `server`, `configured`, `busy`, `embedded`; callbacks `onSend()`, `onReceive(code, serverUrl)`, `onApprove()`, `onRejectVerification()` and `onCancel()`. Preserve any current extra disabled predicate as an explicit boolean if 36 still needs it.

Do not pass a store, service client or vault/app object under a different name. The state object is a reactive snapshot replaced by the view; Pairing does not mutate it. Keep callbacks as closures bound to the correct root/setup facade so embedded receive cannot target the configured library.

## Implementation sequence

1. In Settings read `$session`, `$pairing`, and the setup session/pairing projections at view level. Give standalone Pairing its root snapshots/callbacks and explicit configured flag; embedded Pairing always gets `configured=false` plus the temporary setup snapshots/callbacks.
2. Pass plain Pairing values/actions through Setup to its child. Replace Setup's **pairing-store** read with the supplied plain snapshot for active mode/blocking. Other settings/session subscriptions used by registration can stay for now; do not move them into Pairing or reconstruct a store from the plain snapshot.
3. Rewrite Pairing's props and every `$session`/`$pairing` expression and method call. Derive disabled from busy/active/explicit block state; preserve cancellation/rejection availability during active pairing and all conditional rendering.
4. Keep `code` and disclosure `open` local. On Connect, capture input, clear it at the existing point, trim server and invoke `onReceive`. Do not implement relay/network/persistence or error catching inside the component; those remain in the facade. Keep the server displayed during active pairing from its state snapshot, even if an unrelated form draft changes.
5. Preserve verification-code labels, ARIA references, explicit user approval, status/error placement, countdown and accessible names/modifier classes from 44. Keep no workflow subscriptions, store creation, direct Firefox storage or DOM mutation in Pairing.
6. Review other components with `rg` for store imports, `$store` reads and `create*` workflow constructors. Record component, store/workflow and suitable parent view in implementation notes. Do not convert media URL ownership or root upload-store lifetime to satisfy an architectural style rule.

## Acceptance and verification

- Pairing can render idle sender, idle receiver, active code, verification/approval, error and busy states using plain values alone. No Svelte store is required by its public prop contract.
- Callbacks target the correct root/temporary setup; `onReceive` receives the captured code and trimmed server. Each click/submission fires once; disabled controls do not act.
- Real store updates still update the view/component, including countdown, remote cancellation and failed receive. Root and embedded instances cannot affect the wrong library.
- All item 44 uniqueness checks and existing send/receive/approve/mismatch/cancel cases still pass.

Use the already installed Svelte compiler/server renderer for small plain-prop rendering tests if needed; no component-test dependency/framework is required. Event behavior is verified by the existing browser scenarios through these callbacks. Extend current tests where practical instead of making snapshot tests for every DOM node.

Run client tests/checker/lint and extension build; focused Firefox/Chromium pairing, setup and multi-library scenarios. Inspect configured/embedded narrow Firefox screenshots if markup/styles changed.

## Implementation notes

Pairing now accepts plain `state`, `configured`, `busy`, `server`, `embedded` and explicit send/receive/approve/reject/cancel callbacks. Settings subscribes to root/setup pairing/session snapshots and binds the correct facade; Setup passes these plain values/actions through without subscribing to a pairing store. The plain `state` prop is aliased locally to avoid Svelte `$state` ambiguity. Input/disclosure state remains local; service workflows remain in the store/owner.

Inventory retained for later work: Uploads reads library upload projections (parent Library); MediaCard reads per-media stores and owns rendered resource actions (parent Library); RecoveryImport constructs its recovery workflow store (parent Settings/VaultScreen); RecoveryExport and VaultSettings own async form feedback around vault actions (parent Settings/ManageLibraries); ContextDestination reads app and owns local submission feedback (parent App). These changes are outside this bounded Pairing conversion. Added plain-prop server-render coverage; browser callback verification is recorded in [the batch report](verification-37-46.md).
