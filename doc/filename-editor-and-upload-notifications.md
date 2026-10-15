# Inline filename editing and capture notifications

## Goal and scope

Make the filename editable inline: hover shows a subtle border, clicking opens a
focused text input, Enter submits a generic `{ name }` metadata update, and blur
returns to read-only without saving. Use the tag editor's presentation conventions
and existing media-item store for asynchronous work. Add Firefox notifications
after each extension capture's real upload succeeds or fails.

Exclude new server endpoints, storage formats, identity/session caching, upload
queues, broad transport refactors, and notifications for ordinary file-picker
uploads. The existing app progress/error UI stays authoritative.

## Interfaces and ownership

- A `FilenameEditor` component owns editing state, draft text, and focus only.
  It receives name/disabled props and an ordinary save callback. It has no store,
  storage, or protocol access. Trim surrounding whitespace; require a nonempty
  name and cap typed input at 255 characters. An unchanged name exits editing
  without an HTTP write. Escape discards the draft and returns focus to the label.
- Blur never submits and never moves focus from the user's next control. Discard
  unsaved/failed drafts on blur; reopening starts from the saved filename.
  Successful saving also clears the draft.
  While a save is pending, keep the input read-only and prevent another submission.
  Restore focus after Enter only if the user has not already moved elsewhere.
- `MediaCard` exposes one generic metadata callback for filename and tags. The
  library/media-item stores continue to own patching, busy state, cancellation,
  concurrency conflicts, and failure feedback. Read-only/deleted/unavailable
  metadata cards cannot enter editing.
- The app reports completion for every accepted extension capture. It does not
  know whether the receiving window is temporary. Remove `closeWhenDone` from
  app messages and pending capture state; tab creation stays in the extension.
- The transient bridge listens for each file's completion, then sends the
  extension a correlated result and the original filename. The background checks
  the extension/top-frame sender and configured app URL, shows a success/failure
  notification. App tabs remain open after completion. Notifications use the existing permission/API.
  Completion carries the original app URL, so changing extension preferences
  during an upload does not suppress that upload's result.

## Persistence, cancellation, and failures

Filename drafts are presentation state and disappear with card/view disposal.
Failures preserve the draft while the input remains focused and show existing
card metadata feedback. Conflicts load current metadata while preserving the
focused attempted draft for review. Blur discards that draft without saving.
Blur during a pending request returns to read-only but does not cancel the
store-owned request; a successful response updates the displayed filename.

No new persistent state or resources are added. Pending captures invalidated by
Lock/Reset/Forget/disposal report cancellation so the bridge releases listeners
without a success/failure notification containing the hidden filename. Aborted
uploads likewise do not leak a filename through a locked-screen notification.
Real HTTP/upload failures notify and leave app tabs open with the normal
failure message. Lost acknowledgements retain the existing no-retry behavior.

## Acceptance checks

- Click/Enter renames through `/meta`; card title, detailed filename, image labels,
  and downloads use the saved name. Tags and content bytes remain unchanged.
- Hover/focus affordances, 320/360 px layout, long names, both themes, blur without
  submission, Escape, failed draft retention, and busy/deleted states behave as
  specified. Inspect actual Firefox screenshots.
- Extension success/failure notifications occur after completion, never merely
  after acceptance. Cancellation is silent, ordinary windows never close, and
  all app tabs stay open. Meaningful isolated tests cover the
  completion flow and UI; build/checker and package/static checks pass.

## Native filename form submission

Keep filename editing as a native single-line text form with an explicit hidden
submit button, so Enter and Shift+Enter use the browser's default submit action.
Do not intercept Enter or its modifiers. Use native required/pattern validation
for blank names and the existing metadata callback for saving. Preserve blur,
Escape, failed drafts, busy guards, and focus behavior. The component owns only
presentation state; the store continues to own requests and cancellation. No new
interfaces, persistence, server behavior, or dependencies are introduced.
Acceptance: both Enter variants submit a valid name through the form; blank
names do not submit, blur does not save, and failed drafts remain editable.
