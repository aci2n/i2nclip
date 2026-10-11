# Build:  podman build --network=host -t i2nclip -f Containerfile .
# Run with I2N_ORIGIN and either I2N_DATABASE_URL or I2N_DATABASE_URL_FILE.
# PostgreSQL owns persistent storage.

FROM docker.io/library/node:22.23.3-bookworm-slim AS web
WORKDIR /client
COPY client/package.json client/package-lock.json ./
# Match the smoke CLI's allowance for remote TCP handshakes before trying another address.
# Keep registry failures visible; the final npm exit-handler error can hide them.
RUN NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1000 \
    npm ci --no-audit --no-fund --no-update-notifier --loglevel=verbose
COPY client/index.html client/vite.config.js ./
COPY client/src ./src
RUN npm run build:web

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
COPY --from=web /client/dist/web /usr/local/share/i2nclip/web
ENV I2N_WEB_DIR=/usr/local/share/i2nclip/web
USER i2n
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null && curl -fsS http://127.0.0.1:8080/ >/dev/null
CMD ["i2nclip"]
