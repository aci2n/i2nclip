# Media preview navigation and loading progress

## Goal and scope

Preview images, video, and audio in one dialog using native media elements.
Navigate them in result order with arrow buttons or Left/Right keys, skipping
deleted items and other MIME types. At the loaded boundary, Next fetches more
results and opens the first previewable item, continuing through ordinary-file
pages until media or the end is reached. Do not wrap at either end.

No file prefetch, arbitrary document embedding, codec probing, browser Fullscreen
API, dependencies, or persistence are introduced. Unsupported codecs follow
native player behavior; failed downloads are not automatically skipped.

## Interfaces and ownership

One canPreview(type) predicate defines image/audio/video eligibility for cards,
view navigation, library reveal, and pagination. Cards share one preview button
and prefer thumbnail artwork after opening/downloading media. Players exist only
in MediaDialog; media-item stores own fetched bytes, progress, URLs, and disposal.

The library owns selection, loading/error state, reveal completion checks, and
boundary pagination through the existing submitted-search workflow. Selection
contains the target ID, displayed URL/type/name/artwork, and original opening
control for focus restoration. Views derive adjacent items and progress and pass
ordinary values/callbacks to the dialog. No stores enter components or DOM IDs
are added.

## Presentation

Open immediately using artwork when available. Keep the displayed media and its
own artwork while the next item loads. Show `Loading N%` in a centered overlay
using the selected card's download progress, starting at 0%; 100% may remain
while checking integrity/decrypting. Show `Loading more media…` during pagination,
which has no meaningful download percentage.

Disable previous/next during loading; Close and Escape remain available. Failures
show an error with Retry in the dialog and leave navigation available. Images and
video preserve aspect ratio. Audio shows artwork when available, its filename at
the top, and controls at the bottom, clear of navigation at narrow widths.

Native players have controls and autoplay. Pause the displayed player when loading
starts. Component DOM-effect cleanup pauses it when closing, replacing, or disposing
the presentation. Native Space/playback controls and dialog arrow navigation remain
available. This is local presentation state, not an asynchronous app workflow.

## Lifecycle, failure, and cancellation

Closing supersedes pending preview completion so a late result cannot reopen the
dialog. Media-item downloads and page requests remain root-owned until their
normal completion/disposal. Session invalidation, searches, deletion, and root
disposal clear selection through existing paths. Cached media reuse bytes/URLs.

Reject overlapping navigation/page loads. A page failure retains the current
media and cursor; Retry repeats the page request. Retry on a media failure repeats
reveal. There are no automatic retries. Modified navigation keys retain browser
behavior. Escape/backdrop/Close restore focus to the original card.

## Acceptance checks

- Images, audio, and video share opening, navigation, loading, retry, and close.
- Arrows follow result order, fetch pages as needed, and skip ordinary files.
- Loading preserves current media/artwork, shows percent, and permits dismissal.
- Native player cleanup prevents playback after closing or changing media.
- Stale completion cannot reopen the dialog or replace a newer selection.
- Accessible labels use Media preview, Previous/Next media, and Close preview.
- Native audio controls and captions remain reachable at 320/360 px in both themes.
- Build/checker and static checks pass without warnings; inspect actual Firefox
  rendering. Existing browser fixtures use the current dialog; do not add or run
  tests unless requested.
