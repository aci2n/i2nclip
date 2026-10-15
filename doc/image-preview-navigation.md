# Image preview navigation and loading progress

## Goal and scope

Add previous/next buttons and Left/Right arrow keys to the existing image dialog.
Navigate images in the current loaded search order, skipping deleted and non-image
items. Next loads another results page at the loaded boundary when a cursor
exists, then opens its first image. Skip pages containing only non-images until
an image or the end is reached. Stop at the beginning/end without wrapping. Do
not prefetch files, add fullscreen audio/video, or use browser Fullscreen API.

Show a small centered overlay, `Loading N%`, while the selected image's existing
content download/decryption is pending. Keep the previous image visible beneath
it; initial opening uses the target thumbnail when available. Start at 0% until
download progress arrives; 100% may remain during integrity checking/decryption.
Disable previous/next during loading; Close and Escape always work. Failed loads
show the existing error with Retry beside it, and leave navigation available.
While fetching results pages, show `Loading more images…` rather than a fabricated
percentage. Once an image download starts, show its normal percentage.

## Interfaces and ownership

Library owns selection/loading/error and asynchronous reveal completion checks.
The library store owns boundary pagination through the existing submitted-search
workflow and cursor. Views request it only at the last loaded image.
Selection includes the target media ID and retains the original opening control
for focus restoration. Views derive previous/next from loaded image cards and
pass ordinary booleans, progress, and callbacks into ImageDialog. Media-item
stores continue to own download progress, bytes, object URLs, busy guards, and
cancellation. No stores enter components and no DOM IDs are added.

The dialog opens immediately while the image loads; percent comes from the
selected card's existing download progress. Its current image stays mounted
until a successful replacement is available. Native dialog lifecycle and focus
restoration remain unchanged. Controls must work in both themes and narrow views.

## Persistence, lifecycle, failure, and cancellation

No persistence or dependencies. Closing supersedes preview completion so a late
result cannot reopen the dialog. It does not cancel the media-item-owned download;
existing item caching/resources last until library disposal. Session invalidation,
new searches, deletion, or root disposal clear selection through existing paths.
Navigation rejects overlapping loads; stale completion cannot replace a newer
selection. Download failures stay in the dialog, with manual Retry and no automatic
retry. A page failure retains the current image and cursor; Retry repeats the
page request. Closing during paging leaves the root-owned page request running
but prevents it from opening a preview. Only one page request runs at a time.
Cached images reuse existing bytes/URLs. Modified navigation keys retain
browser behavior. Escape/backdrop/Close restore focus to the original card.

## Acceptance checks

Previous/next buttons and keys follow image order, fetch at the loaded boundary,
and stop when no cursor remains. Pagination preserves the submitted search and
handles non-image pages, errors, and dismissal without reopening. Loading
opens immediately, displays percent changes, preserves the prior image, and blocks
navigation while allowing close. Failure/retry and stale dismissal retain their
specified behavior. Build/checker and static checks pass without warnings. No
additional tests are added or run unless requested. Inspect the actual Firefox
presentation if browser verification is requested.
