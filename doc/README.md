# Documentation

Current wire, storage and credential contract: [protocol](protocol.md), with the
[shared-seed contract](shared-seed/README.md) it implements. One shared library
seed grants full authority; there are no device keys, epochs, recovery principals
or rotation. Read these before changing persistence, keys, pairing, or API behavior.

Documents describe current behavior. Superseded designs are removed rather than
kept beside the current contract; Git history retains them. The Rust server is in
`src/`; the web app and extension are in `client/`.

## Reference

- [Protocol](protocol.md): identity, blocks, HTTP API, credentials, pairing and
  relay, file operations, storage effects, encrypted objects, quotas, threat model.
- [Shared-seed contract](shared-seed/README.md): approved contract and its
  per-commit specifications.
- [Content security policy](content-security-policy.md): entry-page headers.
- [Firefox extension](extension-bridge.md): setup, capture, File handoff, and lifecycle.
- [Store classes](store-classes.md): client store and service structure.
- [Shared styles](shared-styles.md): theme tokens and shared primitives.
- [Database migrations](database-migrations.md): startup, migration history, and schema changes.
- [Test pipeline](test-pipeline.md): commands, toolchains, and fixture isolation.
- [Resource profiling](postgresql-profile.md): optional measurements and reproduction.
- [Transfer and shutdown deadlines](transfer-shutdown-proposal.md): resource and shutdown limits.
- [Large-file test size](large-file-test-size.md): bounded browser transfer fixture.

## Change specifications

Implemented specifications whose behavior is still current:
[rebased mutations](rebased-mutations.md), [HTTPS servers](https-servers.md),
[plain-language UI](plain-language-ui.md), [setup order](setup-order.md),
[password guidance](password-guidance.md),
[metadata index concurrency](metadata-index-concurrency.md),
[backup and purge format](backup-and-purge-format.md),
[upload quota owner](upload-quota-owner.md),
[storage query cleanup](storage-query-cleanup.md),
[hash routing](hash-routing.md), [typed routes](typed-route-table.md),
[file drop](file-drop.md), [upload simplification](upload-simplification.md),
[upload polish](upload-polish.md), [large video thumbnails](large-video-thumbnails.md),
[native download dispatch](native-download-dispatch.md),
[inline source maps](inline-source-maps.md), [client logging](client-logging.md),
[container context](container-context.md), [tag controls](tag-controls.md),
[reliability fixes](reliability-fixes.md),
[streaming review fixes](streaming-review-fixes.md),
[readability cleanup](readability-cleanup.md), [review cleanup](review-cleanup.md),
[code and UI review](code-ui-review.md),
[TypeScript migration](typescript-migration.md) and
[TypeScript review](typescript-review.md).

## Review notes

- [Project audit — 2026-10-22](audit-2026-10-22.md): findings against `36e26a9`
  covering crypto risks, reliability, usability and simplification, with their
  follow-up order and deferred topics.
