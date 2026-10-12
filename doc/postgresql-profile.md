# PostgreSQL process resource profile

`make test-profile` is an optional Linux/Podman check. It prepares release-built server/admin helpers and its debug database helper, owns a disposable PostgreSQL container, and uses a fresh database. The server helper binds `127.0.0.1:0`; Node learns its actual origin from the readiness line. No development port must be free.

The helper uses the real API router and its bounded eight-connection pool. The profile measures transfer resources; production maintenance and graceful shutdown scheduling are outside this harness. It performs two concurrent 32 MiB uploads with 64 KiB sealed metadata, holds two downloads for 250 ms, and verifies lengths, hashes, and every encrypted byte. It repeats with 16 KiB chunked uploads without Content-Length. Held responses must leave zero idle database transactions.

The script samples server RSS every 10 ms and PostgreSQL processes every 200 ms. Health requests run every 20 ms. Timing includes signing, reader pauses, inspection, hash verification, and host scheduling. RSS and responsiveness are measurements rather than pass/fail thresholds. Summed PostgreSQL RSS includes shared pages more than once and is not unique physical memory or cgroup usage.

## Reproduce

Use Node from `client/.nvmrc`, Rust/Cargo, and a local Podman API socket on Linux. The target always creates its own PostgreSQL container, independently of `I2N_TEST_DATABASE_URL`. Explicit `DOCKER_HOST` must select Podman if Docker is also installed. Only the container's randomly mapped database port is published for host clients.

```sh
make test-profile
```

Output includes process counters and timings, without database credentials. Owned responses, server processes, databases, and the container are cleaned up after the run. The Node process and server are measured separately. This check is independent of the portable `make test-all` pipeline.

## Latest local measurement — 2026-10-12

The check passed while an unrelated verification placeholder owned port 8080; that placeholder received no requests.

| Measurement | Value |
| --- | ---: |
| Server baseline RSS | 7,892 KiB |
| Server kernel peak RSS | 249,428 KiB |
| Server final RSS | 76,252 KiB |
| Node client peak RSS | 464,988 KiB |
| Worst measured health response | 783.4 ms |
| Successful health requests | 264 |
| Ordinary round | 5,239 ms |
| Chunked round | 2,512 ms |
| Sampled PostgreSQL summed peak RSS | 497,572 KiB |

These values describe one local run and do not establish a memory or response-time guarantee. Buffer attribution and response-lifetime limits remain follow-up topics in [priorities.md](priorities.md). The separate Rust frame-decoding test retains its allocation-count assertions.
