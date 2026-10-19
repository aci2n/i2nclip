`clip.mp4` is a synthetic two-second, 320×180 VP9 video. It uses an ordinary
MP4 with the `moov` index at the end. The tail-index test inserts an 8 MiB `free`
box before the index without changing sample offsets, then uploads/encrypts it.
Both packaged Playwright browsers can decode VP9; their H.264 availability differs.

Regenerate with FFmpeg (only needed to replace the checked-in fixture):

```sh
ffmpeg -f lavfi -i testsrc=size=320x180:rate=10 -t 2 -c:v libvpx-vp9 -b:v 100k -pix_fmt yuv420p -an -y client/e2e/fixtures/clip.mp4
```
