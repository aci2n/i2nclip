# Upload failures and deleted cards

## Goal and scope

Remove upload retry workflows and retain deleted cards as inactive results. Users
select failed files again through Upload. No automatic pagination, new persistence,
API/schema changes, encryption changes, or registration work is included.

## Interfaces and ownership

The root library store continues to own sequential batches across navigation.
Remove retry/discard methods and their component props and view callbacks. Store
only names and error messages for failed uploads, never failed File references.
The Uploads component renders progress, completed uploads, and failure messages.

Media items continue to own deletion requests, decrypted bytes, and URLs. Successful
deletion disposes those resources and publishes deleted state; the library retains
the item and subscription in its existing position. Existing gray styling and
disabled actions remain. Close the image preview on deletion without changing the
pagination cursor or empty state. A new search replaces the displayed results.

## Lifecycle and failure behavior

New accepted batches clear previous upload messages. Individual failures record
name/error messages and do not stop the batch. The summary tells users to select
failed files again. Session changes and disposal clear transient state; stale
progress/results remain ignored. Nothing new is persisted. Failed or canceled
deletions preserve active cards and existing error reporting.

## Acceptance

Unit tests cover sequential continuation, message-only failures, manual resubmission,
and cancellation. Deletion tests cover retained inactive cards, URL revocation,
unchanged pagination/empty state, failed deletion, and replacement on new search.
Browser tests cover manual resubmission across navigation and visible gray cards
with disabled actions. Run make test, make client, affected browser scenarios, and
inspect Firefox screenshots, including narrow layouts and both themes.
