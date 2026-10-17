# Final TypeScript review

## Goal and scope

Review the maintained web app, Firefox extension, tooling and tests against the
[TypeScript handbook](https://www.typescriptlang.org/docs/). Preserve behavior and
keep contracts readable. Desktop remains excluded. This follows the compiler-clean
migration and the explicit interface/lifecycle review.

## Interfaces and ownership

Use inference for local values and concrete, subsystem-owned contracts for shared
capabilities. Presentation callbacks whose results are ignored return void;
callbacks whose promises/results are consumed retain their actual contract.
Use unknown for untrusted inputs, narrow before access, and avoid type assertions
where ordinary annotations or control flow suffice. Keep necessary assertions at
validated object/binary boundaries and in self-contained injected extension code.
Use primitive types, type-only imports, discriminated state, and genuine optional
fields; do not replace invariants with non-null assertions or arbitrary defaults.
Keep imports together before component declarations. Store factory return types
may remain inferred; no duplicate manual store interfaces or generic framework.

## Persistence and lifecycle

No schema, wire, crypto, routing, persistence or lifecycle changes. Existing
session invalidation, stale-write rejection, cancellation and disposal remain.
No new dependencies. Failure behavior stays covered by existing meaningful tests.

## Checks and exclusions

Review strict compiler configuration and enable useful additional diagnostics
only when they fit the source's contracts. Do not add non-null assertions or
unnecessary runtime checks just to enable optional compiler flags. Check sparse
lookups and JSON/process boundaries explicitly. Verify client static/unit checks,
Rust tests, web and extension builds, and the real Firefox/Chromium suite after
changes. The review is a concrete application of handbook guidance, not a claim
that the handbook mandates every optional compiler flag.

## References

- [Everyday types: inference, assertions, null and undefined](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)
- [Narrowing and discriminated unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Function callbacks and void](https://www.typescriptlang.org/docs/handbook/2/functions.html)
- [Compiler options](https://www.typescriptlang.org/tsconfig/)

## Completed review

Presentation and browser-event callbacks use void where results are ignored.
Awaited workflow callbacks keep unknown results where callers intentionally await
completion but do not consume a value. Save callbacks retain Promise<boolean>.
Shared quota, pairing-key, session and API contracts belong to their providers;
test fixtures use those contracts directly instead of nested utility types.
Remaining Parameters uses forward actual method signatures in test wrappers.

Sparse MIME lookup tables express absent entries without assertions. External
object/buffer assertions remain behind validation; injected extension functions
keep their self-contained boundary checks. Version-controlled JSON vectors use
typed JSON imports, and process/build JSON is narrowed before field access.
Svelte imports are grouped before declarations. Strict checking additionally
covers implicit returns, switch fallthrough and unresolved side-effect imports.

Validation: make test, make test-build, and the real Firefox/Chromium suite pass
(64 browser tests). Client checking reports zero errors and zero warnings.
