# Build:  podman build -t i2nclip -f Containerfile .
# Run with I2N_ORIGIN and either I2N_DATABASE_URL or I2N_DATABASE_URL_FILE.
# PostgreSQL owns persistent storage.

FROM docker.io/library/node:22.23.3-bookworm-slim AS web
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1000 \
    npm ci
COPY client/index.html client/vite.config.js client/service-tracing.config.js ./
COPY client/public/favicon.ico ./public/favicon.ico
COPY client/src ./src
ARG CLIENT_BUILD_MODE=production
RUN npm run build:web -- --mode "$CLIENT_BUILD_MODE"

FROM docker.io/library/rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY sql ./sql
RUN cargo build --release --locked --bin i2nclip

FROM docker.io/library/debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home i2n
COPY --from=build /src/target/release/i2nclip /usr/local/bin/i2nclip
COPY --from=web /client/dist/web /usr/local/share/i2nclip/web
ENV I2N_WEB_DIR=/usr/local/share/i2nclip/web
USER i2n
EXPOSE 8080
CMD ["i2nclip"]
