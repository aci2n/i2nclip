# Descriptive capture filenames

## Goal and scope

Name extension captures using the clicked media's description rather than generic
URL basenames. In Firefox, `menus.getTargetElement(info.targetElementId)` identifies
the exact clicked element in its source frame, avoiding ambiguity when several
images share a URL. Replace the synonymous `contextMenus` permission/API with
`menus`, required for reading that target. Inject only a small read-only function
in the clicked frame, immediately after the user chooses the capture action.

Priority: nonblank image alt text, element title, element aria-label, document
title, then the source page URL (host, path, query, and fragment, excluding URL
credentials). If source inspection is unavailable, use the existing tab title
and context-menu frame/page URL. Use the downloaded URL basename only when no
page context is available. Context extraction failure must not prevent upload.

Normalize whitespace, replace filename/path control characters, keep useful
Unicode text, and cap the name at 255 characters including its extension. Use an
extension matching a known downloaded MIME type, otherwise retain a usable
source-file extension. Avoid adding a second copy of the same extension.

## Ownership and exclusions

The extension owns label extraction and filename selection. The web app receives
an ordinary File and stores its name in encrypted metadata through the existing
upload. The app's identity, upload workflow, focus/popup lifecycle, and server API
do not change. No persistence or extra content scripts are registered. No page
HTML, cookies, authenticated fetch fallbacks, image matching heuristics, naming
settings, timestamps, counters, or global uniqueness scheme are introduced.

## Lifecycle and failure cases

The clicked target ID is short-lived: inspect it before finding/opening the app
or downloading media. If it has expired, the element is gone, the frame navigated,
or injection is denied, use page context without failing capture. Media bytes and
type remain those of the original selected URL. Names exist only with the capture
and normal upload state; cancellation and disposal keep their current behavior.

## Acceptance checks

- Exact clicked image alt text wins over generic media basenames and page titles;
  video/audio title and aria-label work, and blank descriptions fall through.
- Page title or URL supplies a readable fallback, including routes/query values
  that distinguish otherwise generic captures.
- Native Firefox captures the correct descriptive name through the real API;
  hidden locked receipt and temporary popup closure still work.
- Filename safety, Unicode, extensions, and length are covered by isolated tests;
  injection failure still captures; package/static checks pass and rebuild outputs.

Reference: [Firefox menus.getTargetElement](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/getTargetElement).

## Verification

All 86 client unit cases and Svelte checking pass, including exact target lookup,
attribute priority, page-title/URL fallback, safe Unicode filenames, extension
handling, and source-frame injection failure. Package/static checks pass. A fresh
native Firefox profile captured the second of two identical-source images with
different alt text through the real Rust API and an isolated database. The stored
filename was `Mountain portrait in Córdoba.png`; locked receipt stayed hidden,
unlock uploaded automatically, and the popup closed after success.
