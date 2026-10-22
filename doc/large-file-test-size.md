# Large-file browser test size

## Goal and scope

Keep `client/e2e/large-files.spec.ts` from exhausting host memory while it
still verifies a real encrypted multi-chunk upload and native download across
view navigation. Reduce the transferred file from 1 GiB + 123 bytes to
64 MiB + 123 bytes, and hold the download open until navigation has happened.

Exclusions: application, protocol, server, schema and quota changes; Playwright
configuration (workers, projects, temporary directories); memory assertions;
changes to other browser tests.

## Rationale

Playwright's Firefox driver copies every request body up to 10 MiB into the
test runner, and the runner retains each `Request` until the page closes. Every
4 MiB upload chunk is copied, so a 1 GiB upload retains about 1 GiB in the
Firefox worker process. Each native download is also saved under `os.tmpdir()`,
which is RAM-backed tmpfs on common Linux hosts. Both browser projects can run
the test concurrently.

The 1 GiB size added no assertion that 64 MiB lacks. The test records resource
samples but asserts no memory bound, and 1 GiB crosses neither 2^31 nor 2^32.
Offsets beyond 8 GiB, a generated 1 GiB native download and the 4 MiB bound on
source reads remain covered by `streaming.spec.ts` without uploading content.
64 MiB + 123 bytes is sixteen full chunks plus a partial final chunk and stays
above the 32 MiB preprocessing cutoff.

## Behavior

- Write the fixture in bounded blocks beneath ignored `client/dist/`, remove it
  in `finally`, and verify size and streamed SHA-256 of the native download.
- Route content chunk GETs with `continue`; the second one waits until the
  Settings navigation has been clicked, so navigation always precedes download
  completion. The first passes so the browser can start the native download.
  No response bodies are fulfilled or copied by the route.
- Keep the 32 MiB preprocessing notice, quota count and resource attachment.
- Use the default test timeout and a 60-second upload wait instead of the
  600- and 300-second limits sized for 1 GiB. Size the quota at 128 MiB.

## Acceptance

- Biome check and TypeScript checks pass for the client.
- With approval, `large-files.spec.ts` passes in Firefox and Chromium.
- Documentation that cites the 1 GiB browser transfer reflects the new size.
