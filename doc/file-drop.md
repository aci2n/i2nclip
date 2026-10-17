# App-wide file drops

## Goal and scope

Dropping one or more files anywhere in the app starts the existing upload batch
when the library is ready and no upload is running. Application owns window-level
drag/drop handlers and passes files to its root-owned uploads store. Accepted
drops open Library so existing progress, completion, and failure feedback is visible.

## Interfaces and lifecycle

Use browser DragEvent/DataTransfer files; do not change store or protocol APIs.
Prevent browser file navigation for file drags and drops, including when locked,
unconfigured, or busy. Advertise copy only when an upload can start. Leave text
and link drags alone. Window handlers live only for the Application lifetime.
Uploads retain their existing sequential processing, preferences, validation,
failure continuation, session cancellation, and in-memory state across navigation.
No dropped files are retained when a drop is rejected.

## Exclusions

No drop overlay, new styling, upload queue, directory traversal, URL uploads,
persistence, dependencies, or changes to the file picker or encryption protocol.

## Acceptance checks

- Browser tests drop multiple files on nested app content in Settings and on the
  document outside main; Library opens and uploaded files appear.
- Locked/unconfigured/busy drops cannot start uploads; file drop defaults are
  prevented, while non-file drag/drop defaults remain untouched.
- Existing upload tests, client checks, and production build pass without warnings.
