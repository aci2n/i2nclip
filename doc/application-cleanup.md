# Application coordination and routing cleanup

## Goal, scope, and exclusions

Extract root application coordination from Application.svelte and isolate query
routing. Preserve rendering, existing URLs, modified clicks, upload eligibility,
and errors. No hash routing, server/schema/protocol changes, new dependencies,
persistence, compatibility paths, or visual changes.

## Interfaces and ownership

createApplication owns session, preferences, pairing, extension receiver, routing,
workspace and subscriptions. It exposes child stores, readable workspace state,
canDropFiles(), dropFiles(files), and dispose(). The routing store exposes typed
routes, pure URL parsing/formatting, navigate(route, replace), and disposal.
Views handle DOM events and pass ordinary href/callback props to components.

## Persistence and lifecycle

Create workspace lazily for configured Library/Settings visits; retain it across
all navigation, including Media, until context replacement or root disposal.
Fresh media tabs do not fetch lists/tags. Keep existing preference/session
persistence; introduce none. Media retains its existing view-owned lifetime.
Programmatic navigation publishes immediately; popstate reads the URL.
Ordinary links push history; accepted drops/extension handoffs replace it.
Missing/unknown pages select Library. Invalid media IDs retain local errors.

## Failure and cancellation

Reject empty, unconfigured, locked, busy or overlapping drops without retaining
files. Preserve extension rejection and upload error behavior. Existing stores
own cancellation/stale-result checks. Dispose listeners/subscriptions and owned
resources on root teardown; context replacement ends the old workspace.

## Acceptance checks

Test route parsing/formatting, push/replace, immediate updates, history events
and disposal. Verify lazy/preserved/replaced workspace and root cleanup, plus
upload survival across navigation. Run client tests/checks, warning-free client
build, and Firefox/Chromium navigation, deeplink, file-drop and extension tests.
Browser fixtures must own isolated resources and clean up on failure.
