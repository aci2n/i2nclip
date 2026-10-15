# Web framing protection

## Goal and scope

Fix security audit finding 5 by preventing embedding of the web application in
frames, including frames from its own origin. The Rust web router owns this
HTTP response policy. Its entry routes (`/`, `/index.html`, and the favicon route
that shares their middleware) send `Content-Security-Policy: frame-ancestors 'none'`.
Query strings do not change the policy. Include HEAD and conditional responses.

## Interfaces and ownership

Add the header in the existing entry-response middleware in `src/web.rs`.
Preserve cache headers, response bodies, content types, and API/asset routing.
No client changes, new dependencies, settings, or broader CSP directives.
No additional legacy-browser compatibility headers.

## Persistence, lifecycle, and failures

The policy is stateless and applied to each entry-route response, including
errors and 304 revalidation responses. It adds no resources, asynchronous work,
persistence, cancellation behavior, or database/schema changes. A proxy must
preserve the response header. Browser enforcement intentionally prevents iframe
embedding; ordinary top-level navigation remains available.

## Acceptance checks

Router tests verify the exact CSP for GET and HEAD on both HTML entry paths and
query variants, conditional GET returning 304, and a missing entry file returning
404. Verify asset and API responses do not acquire this entry-route policy.
Run Rust tests, formatting checks, and a warning-free build. No visual changes
or browser screenshot review are needed.
