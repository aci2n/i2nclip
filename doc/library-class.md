# Library store class trial

## Goal and scope

Convert only Library's instance workflows to a class so private state and injected
services no longer travel through dependency/runtime parameters. This supersedes
`store-functions.md`'s prohibition on classes for Library only. Keep tag submission
normalization as a module-level pure helper. No base classes or shared framework.

## Interfaces and ownership

Preserve `createLibrary(context, options)`, its exported structural Library type,
state shape, subscription contract, commands, arguments and return values. The
factory returns a private implementation class. Public commands are bound once in
a grouped section above the constructor so detached callbacks retain their
receiver. All command implementations and internal workflows use ordinary private
methods. Keep the writable, resources and dependencies private, injecting services
once through the constructor. Initialize all fields before starting the existing
initial search. Workspace retains ownership across navigation; media items retain
ownership of their own URLs and downloads.

## Lifecycle, persistence and failures

Keep all state in memory and retain current initialization, synchronous card
notifications, search replacement, submitted-query pagination, cancellation,
stale-result checks, preview cleanup, metadata notifications, deletion behavior,
errors and disposal ordering. Do not promote operation-local variables into
instance fields. No changes to other stores, rendering, protocol, persistence,
schema, dependencies or application behavior.

## Acceptance

Existing Library/media lifecycle tests must pass. Add public-interface regressions
for detached commands/subscriptions and independent Library instances, including
one instance disposing while another continues. Run the full client test suite,
client checker and web build without warnings. Review the diff for unchanged
workflow behavior and commit the cohesive trial.

## Verification result

`make -C client test` passed all 36 test files and the Biome, TypeScript and
Svelte checks, with zero errors or warnings. `make client` built successfully
without warnings. The new regressions cover detached subscription/command use and
independent instance cancellation, publication and pagination. No UI changed.
