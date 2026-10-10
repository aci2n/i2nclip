# PostgreSQL process memory profile

Measured locally on 2026-10-10 with an optimized Rust server, Node 22.23.3, and disposable PostgreSQL 18 under rootless Podman. The server and Node client are separate processes. This is a local measurement, not a production memory limit.

Each run uses a fresh isolated database and the production server's eight-connection pool. It performs two concurrent 32 MiB uploads with 64 KiB sealed metadata, then two concurrent downloads. It repeats with 16 KiB chunked upload writes without Content-Length. Download readers pause for 250 ms before draining, and downloaded hashes must match. PostgreSQL uses the image defaults rather than the production Quadlet's complete configuration.

The script samples server RSS every 10 ms and reads the kernel's lifetime VmHWM. Its second run also samples PostgreSQL processes every 200 ms. Independent health requests run every 20 ms; their measured latency includes local network and client scheduling, not just server event-loop delay.

| Measurement | First run | Second run |
| --- | ---: | ---: |
| Server baseline RSS | 7,088 KiB | 7,148 KiB |
| Server kernel peak RSS | 291,180 KiB (284.4 MiB) | 239,744 KiB (234.1 MiB) |
| Server final RSS | 174,820 KiB | 141,684 KiB |
| Server RSS with ordinary downloads held | 204,744 KiB | 205,452 KiB |
| Server RSS with chunked-round downloads held | 240,364 KiB | 207,228 KiB |
| Client peak RSS, excluded from server figures | 486,408 KiB | 539,092 KiB |
| Worst health-response latency | 28.6 ms | 34.0 ms |
| Successful health requests | 100 | 101 |
| Ordinary round elapsed time | 1,028 ms | 1,058 ms |
| Chunked round elapsed time | 1,019 ms | 1,030 ms |

Round times include signing, the deliberate reader pause, process inspection, and hash verification; they are not pure transfer-throughput measurements. The second run used 0.39 seconds of application CPU (39 ticks at 100 ticks/second).

PostgreSQL's second-run baseline summed process RSS was 121,652 KiB; the sampled maximum was 582,872 KiB (569.2 MiB). Held-download snapshots contained 13 PostgreSQL processes and summed to 349,284 KiB and 534,688 KiB. The largest individual processes in those snapshots used 82,804 KiB and 132,180 KiB. Summed RSS counts shared PostgreSQL pages more than once: it must not be treated as unique physical memory or cgroup memory. CPU counters for the live processes rose from 2 ticks at baseline to 77 ticks in the final held-download snapshot; exited processes are not included.

Both rounds had zero idle database transactions while responses were held. This observation supplements the private pool test that acquires all eight connections after content has been fetched; idle-transaction counts alone cannot prove a connection was returned to the pool.

The server peak is substantially above the 64 MiB of content in two transfers. SQLx buffers, HTTP Vec growth, concurrent downloads, and allocator retention need allocation-level measurement to attribute that difference. This profile does not establish a hard bound or justify changing the accepted full-buffer download design. Buffer-growth and response-duration work remains in priorities.md.

## Reproduce

Use Linux, Node from `client/.nvmrc`, and the local rootless Podman API socket. Port 8080 must be free. The runner owns the container; the script owns its isolated database and server process. All are cleaned up after the profile. The script does not run in ordinary client tests.

```sh
cargo build --release
cargo build --example test-database
DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock \
  I2N_TEST_CONTAINER_NETWORK=host \
  cargo run --quiet --features test-containers --example postgres-tests -- \
  node client/tests/profile-postgres.js
```

Unset `I2N_TEST_DATABASE_URL` so the runner provisions its own PostgreSQL container. The host-network fallback binds PostgreSQL only to loopback; omit `I2N_TEST_CONTAINER_NETWORK` when the default container network works. PostgreSQL process inspection requires local Podman access. Output contains resource counters and timings, not database credentials.
