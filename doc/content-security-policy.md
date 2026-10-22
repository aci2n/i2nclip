# Content security policy

Change specification for audit finding A1 ([audit](audit-2026-10-22.md)).

## Goal

Any script that runs in the app's origin has full library authority: it can sign
blocks and export a sealed backup of the seed. The library-identity boundary does
not defend against same-origin code. Entry responses therefore restrict script,
style, worker, and connection sources so an injected markup fragment cannot
execute code or exfiltrate through arbitrary hosts.

## Scope

The Rust static web layer (`src/web.rs`) sets these headers on the entry HTML
responses (`/`, `/index.html`, `/favicon.ico`, including `304` and `404`):

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' blob:; media-src 'self' blob:; worker-src 'self';
  connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*;
  manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none';
  frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Assets and the streaming worker also send `X-Content-Type-Options: nosniff`.
API responses are unchanged.

`connect-src` allows HTTPS servers and loopback HTTP because the configured server
may differ from the page origin. A plain-HTTP server on another host is refused by
the browser; finding A2 aligns the client's server validation with the same rule.

## Repository facts relied on

- The Vite build emits only external module scripts and stylesheets; `index.html`
  has no inline script or style, and components contain no `style=` attributes,
  transitions, frames, embeds, or external hosts.
- Media, thumbnails, and backup downloads use `blob:` URLs; streamed playback goes
  through the same-origin service worker (`/streaming-worker.js`).
- Inline source maps are data embedded in JavaScript, not loaded resources.

## Exclusions

No nonce or hash machinery, report-uri, Trusted Types, COOP/COEP, HSTS (a TLS
terminator concern), or headers for the Vite development server.

## Failure cases

A future inline script, inline style attribute, or third-party resource will be
blocked. That is intended; such a change must update this policy explicitly.

## Acceptance

- Rust web tests assert the exact policy and companion headers on entry routes
  (`GET`, `HEAD`, `304`, `404`) and `nosniff` on assets and the worker, with no CSP
  on assets or API responses.
- `cargo test --lib` passes. Browser verification of the running app under the
  policy remains pending explicit E2E approval.
