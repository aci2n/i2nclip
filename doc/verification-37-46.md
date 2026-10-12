# Verification of TODOs 37–46

Implemented on `settings-followups`, with one initial commit per TODO and separate commits for the requested ID-free Pairing refinement and verification fixes. The user requested combined testing after implementation rather than repeating suites for every item.

## Results

- `make test-client`: 181 tests passed; Svelte checker reported zero errors/warnings. The later authorization-disappearance regression passed with all four settings tests; its change also passed checker/lint.
- `npm run lint --prefix client` (via `rtk proxy` for readable output): zero errors/warnings. The sole important hidden declaration has a narrow documented lint exception.
- `make web extension`: web ZIP and extension XPI built without warnings, including a final rebuild after the authorization feedback change.
- Browser coverage: all 64 Firefox/Chromium scenarios passed across the end-of-batch run and focused recovery runs. The initial run was stopped after a Svelte `state`/`$state` collision; the prop is now aliased locally. Pairing's ID removal required explicit container names and output-role selectors. Non-pairing coverage passed in the resumed run, the 14 remaining Chromium cases passed separately, and all 24 pairing/multi-library cases passed after selector correction. No passing database/Rust suite was rerun for these client changes.
- Focused runtime coverage includes normalized multi-tag reconciliation, zero list requests after editing, unchanged card identity/cursor/draft, stale pagination exclusion, mutation during token verification, conflict membership retention, newest-first uploads and independent completion expiry while later work remains active.
- Plain-prop Pairing server-render coverage passed without a Svelte store. Browser callbacks cover sender/receiver, approval, cancellation, cross-target pairing, duplicate selection and temporary receiver disposal.
- Inspected emitted web/extension CSS: one global `reset, base, controls, layout` order, scoped component selectors outside layers, and the hidden invariant outside layers. Minification remains disabled.

## Visual review

Opened actual Firefox screenshots for realistic landscape/portrait/panorama images, audio/video and long ordinary filenames, long tags, upload progress, first/additional setup, recovery, About and active pairing. Reviewed light/dark at 320/360 px, including `service-library-320`, `uploads-progress-320`, `setup-first-320`, `setup-restore-320`, `setup-temporary-first-*`, `setup-temporary-add-*`, `service-pairing-320` and `about-extension-360` under ignored `client/e2e/shots/firefox/`. Browser overflow assertions passed. Controls, warnings, focus, hidden panels and component spacing remain usable.

## Item outcomes

| TODO | Verified outcome |
| --- | --- |
| 37 | Forget is a warning control immediately before Reset, with captured-ID/double-submit protection and local errors. |
| 38 | Saved server editing is absent; setup drafts preserve the saved server and recovery/pairing keep their encoded server. |
| 39 | Completed rows display 100% until their individual deadline; active/failed work survives independent cleanup. |
| 40 | Tags reconcile each submitted query without a list request; old responses cannot overwrite metadata or excluded membership. |
| 41 | New uploads lead every matching view, newest completion first, without recreating unaffected cards. |
| 42 | Authorize uses eligible saved identities only; three/four-tab keyboard behavior and visible failure fallback are retained. |
| 43 | Semantic reset preserves controls; recovery/failure lists own their indentation and stacks own spacing. |
| 44 | Pairing has no IDs or prefix/suffix API; whole-document ID/IDREF checks pass in simultaneous sender/receiver and feedback states. |
| 45 | Pairing renders plain values and invokes explicit callbacks supplied by views; other component store ownership is inventoried in its plan. |
| 46 | Global layers and native nesting build cleanly and preserve themes, hidden semantics and scoped component ownership. |
