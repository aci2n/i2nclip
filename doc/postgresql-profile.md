> Historical design note. Chain, credential, storage, and API details are superseded by [the current protocol](protocol.md) and the [shared-seed contract](shared-seed/README.md).

# PostgreSQL process resource profile

`make test-profile` is an optional Linux/Podman check. It prepares release-built server/admin helpers and its debug database helper, owns a disposable PostgreSQL container, and uses a fresh database. The server helper binds `127.0.0.1:0`; Node learns its actual origin from the readiness line. No development port must be free.

The helper uses the real API router and its bounded eight-connection pool. The profile measures transfer resources; production maintenance and graceful shutdown scheduling are outside this harness. It dispatches two 32 MiB uploads with 64 KiB sealed metadata for the same key (the server admits one upload per key at a time), holds two downloads for 250 ms, and verifies lengths and every encrypted byte. It repeats with 16 KiB HTTP transfer chunks without Content-Length. Downloads use sequential stable 4 MiB + tag chunk URLs. Held responses must leave zero idle database transactions. A final saturation round uploads one file for each of eight owners, holds sixteen concurrent chunk responses for 250 ms, records server RSS and PostgreSQL resources, then verifies all complete files.

The script samples server RSS every 10 ms and PostgreSQL processes every 200 ms. Health requests run every 20 ms. Timing includes signing, reader pauses, inspection, hash verification, and host scheduling. RSS and responsiveness are measurements rather than pass/fail thresholds. Summed PostgreSQL RSS includes shared pages more than once and is not unique physical memory or cgroup usage.

## Reproduce

Use Node from `client/.nvmrc`, Rust/Cargo, and a local Podman API socket on Linux. The target always creates its own PostgreSQL container, independently of `I2N_TEST_DATABASE_URL`. Explicit `DOCKER_HOST` must select Podman if Docker is also installed. Only the container's randomly mapped database port is published for host clients.

```sh
make test-profile
```

Output includes process counters and timings, without database credentials. Owned responses, server processes, databases, and the container are cleaned up after the run. The Node process and server are measured separately. This check is independent of the portable `make test-all` pipeline.

Measurements depend on the current implementation and host. Run the profile for
current results; earlier local measurements predate quota and permit changes.
Buffer attribution and response-lifetime limits remain follow-up topics in
[priorities.md](priorities.md). The Rust frame-decoding test separately checks
allocation behavior without claiming an end-to-end RSS bound.

## Chunk-storage cutover measurement

The 2026-10-19 run passed with zero held-download transactions. Server baseline
RSS was 8,148 KiB; the sampled peak was 169,364 KiB and process high-water mark
174,252 KiB. Sixteen held chunk responses used 123,916 KiB RSS. The largest of
1,150 health-check latencies was 62.6 ms. These are host-specific observations,
not memory or latency guarantees. PostgreSQL's summed peak RSS was 1,212,404 KiB
(shared pages counted repeatedly); the Node load generator peaked at 433,408 KiB.

`large-files.spec.ts` additionally verifies a real encrypted 1 GiB + 123-byte
upload and native download in each browser, checks the downloaded file's size
and streamed SHA-256, and navigates during the download. On Linux it attaches
baseline and sampled peak browser process-tree/server RSS as `transfer-resources`.
Browser RSS sums include shared pages repeatedly and automation/browser overhead;
they do not isolate JavaScript buffers or the decoder. Source fixtures are written
in bounded blocks beneath ignored `client/dist/` and removed in `finally`.
