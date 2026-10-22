> Historical design note. Superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md), which replaced device membership, epochs, recovery and rotation with one shared library seed.

# Chain implementation verification

Completed 2026-10-21 on the greenfield chain branch. The application uses canonical
genesis, separate initial enrollment, independent device signing/encryption keys,
recovery-signed membership changes, and device-preserving epoch rotation.
Recovery enrollment preserves existing devices; optional explicit recovery
revocation frees capacity before enrollment. Legacy media API and reset/replacement
credential flows are removed. Review findings collected separately remain for
later assessment; this verification does not resolve or endorse them.

## Results

Use the Node version in `client/.nvmrc` on PATH and the toolchain/container
prerequisites in [test pipeline](test-pipeline.md).

`make test-all` completed all non-browser stages successfully before its browser
process was interrupted during the session:

- 230 client tests passed.
- Biome, TypeScript, Svelte, Clippy, and Rust formatting passed without application
  warnings; web/extension builds and all three build-content checks passed.
- PostgreSQL-backed Rust verification passed: 65 library tests, three main tests,
  five configuration tests, and 14 API tests. The main suite retains its existing
  ignored subprocess fixture.

Final browser verification used `make test-e2e`, real local Rust listeners,
isolated PostgreSQL databases, and independent Firefox/Chromium contexts.
The full 132-case run finished with 130 passes, one existing Firefox
worker-termination skip, and one intermittent Firefox pairing-disclosure failure.
That exact failing case passed all three isolated repeats, with tracing enabled
on failure. Thus all 131 enabled cases passed across the full run and targeted
recheck; the full run itself was not entirely green. The failed snapshot showed
the pairing disclosure closed before code creation. Its cause was not reproduced
and no speculative application change was made.

Both browsers passed real encrypted upload/download above 1 GiB, bounded generated
stream downloads, native playback/seeking, cancellation, offline recovery,
retained-device epoch delivery, metadata/search, pairing, extension capture,
independent tabs, time travel, and explicit purge. Chromium's reproducible native
download cancellations were fixed by [ordinary attachment dispatch](native-download-dispatch.md).
Its previously failing chain cases passed immediately after the fix; the subsequent
full browser run passed every Chromium case. Targeted chain-library lifecycle tests
and client static checks also passed after that change.

Inspected actual Firefox screenshots of mixed portrait/landscape/panorama, video,
audio, ordinary files, long names, and settings errors in light/dark themes at
320/360 px and desktop widths. Preview aspect ratios, wrapping, controls, and
local error placement fit these views. Screenshots are test-owned ignored artifacts
under `client/e2e/shots/`, not committed fixtures.

The optional Linux resource profile was not run. Browser launchers emitted the
existing NO_COLOR/FORCE_COLOR environment notices; production builds were clean.
