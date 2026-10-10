# Build:  podman build --network=host -t i2nclip -f Containerfile .
# Run:    podman run --rm -p 8080:8080 -e I2N_ORIGIN=https://clip.example.com -v i2nclip-data:/var/lib/i2nclip:Z localhost/i2nclip

FROM docker.io/library/rust:1-bookworm AS build
WORKDIR /src
ENV CARGO_TERM_COLOR=never
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked
COPY src ./src
COPY sql ./sql
RUN find src sql -type f -exec touch {} + \
    && cargo build --release --locked

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /var/lib/i2nclip --create-home i2n
COPY --from=build /src/target/release/i2nclip /usr/local/bin/i2nclip
USER i2n
WORKDIR /var/lib/i2nclip
EXPOSE 8080
VOLUME ["/var/lib/i2nclip"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
CMD ["i2nclip"]
