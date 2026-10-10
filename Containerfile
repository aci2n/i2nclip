# Build:  podman build --network=host -t i2nclip -f Containerfile .
# Run with I2N_ORIGIN and either I2N_DATABASE_URL or I2N_DATABASE_URL_FILE.
# PostgreSQL owns persistent storage.

FROM docker.io/library/rust:1-bookworm AS build
WORKDIR /src
ENV CARGO_TERM_COLOR=never
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src tests examples \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf 'fn main() {}\n' > examples/postgres-tests.rs \
    && printf '#[test]\nfn manifest_target_placeholder() {}\n' > tests/postgres_api.rs \
    && cargo build --release --locked
COPY src ./src
COPY sql ./sql
RUN find src sql -type f -exec touch {} + \
    && cargo build --release --locked

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home i2n
COPY --from=build /src/target/release/i2nclip /usr/local/bin/i2nclip
USER i2n
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
CMD ["i2nclip"]
