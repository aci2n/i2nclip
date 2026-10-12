# `make` builds the Rust server and Svelte client. Run npm ci --prefix client once.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com
COMPOSE ?= podman compose
DEV_PORT ?= 8080
DEV_DB_PORT ?= 5432
DEV_ORIGIN ?= http://localhost:$(DEV_PORT)
DEV_DB_URL ?= postgresql://i2nclip:i2nclip-dev@127.0.0.1:$(DEV_DB_PORT)/i2nclip?sslmode=disable
SMOKE_SERVER ?= https://clip.i2n.duckdns.org
SMOKE_DIR ?= $(HOME)/.config/i2nclip/smoke

-include local.mk

.DEFAULT_GOAL := build
.PHONY: build client web extension cli packages dev-extension run container push

build: client
	cargo build

client:
	$(MAKE) -C client build

web extension cli packages dev-extension:
	$(MAKE) -C client $@

run:
	I2N_ORIGIN="$(DEV_ORIGIN)" I2N_DATABASE_URL="$(DEV_DB_URL)" cargo run $(RUN_ARGS)

debug:
	rust-gdb target/debug/i2nclip

# Local containers: web/API and PostgreSQL ports bind to loopback.
.PHONY: dev dev-db dev-down dev-otc
dev dev-db dev-down dev-otc: export DEV_PORT := $(DEV_PORT)
dev dev-db dev-down dev-otc: export DEV_DB_PORT := $(DEV_DB_PORT)
dev dev-db dev-down dev-otc: export DEV_ORIGIN := $(DEV_ORIGIN)

dev:
	$(COMPOSE) up --build --exit-code-from server server

dev-db:
	$(COMPOSE) up --detach --wait --wait-timeout 90 db

dev-down:
	$(COMPOSE) down

dev-otc:
	$(COMPOSE) exec -T server i2nclip otc issue

# Tests and verification. Install toolchains and client dependencies first.
.PHONY: test test-client test-packages test-extension-pairing test-db test-profile test-e2e test-smoke test-all
.PHONY: lint format-check format-write pre-commit audit client-test e2e smoketest

# Fast checks: client unit tests, Svelte type checking, and Rust unit/config tests.
test: test-client
	cargo test

# Shared libraries, CLI, and smoke-runner unit tests, plus the Svelte checker.
test-client:
	$(MAKE) -C client test

# Build all three archives; verify their contents and run the extracted CLI.
# Requires zip, unzip, and GNU tar.
test-packages:
	$(MAKE) -C client test-packages

# Installs the built add-on in an isolated Firefox profile to verify Worker/WASM CSP.
test-extension-pairing:
	$(MAKE) -C client test-extension-pairing

# Rust PostgreSQL API/protocol tests using isolated databases; TEST_ARGS adds filters.
# Provisions PostgreSQL through Docker/Podman unless I2N_TEST_DATABASE_URL is set.
test-db:
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  cargo run --quiet --features test-containers --example postgres-tests -- \
	  cargo test --features postgres-tests $(TEST_ARGS)

# Verify maximum-size/chunked transfers and held downloads; report process resources.
# Requires Linux, local Podman, port 8080 free, and an owned PostgreSQL container.
test-profile:
	cargo build --release
	cargo build --example test-database
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  env -u I2N_TEST_DATABASE_URL cargo run --quiet --features test-containers --example postgres-tests -- \
	  $(MAKE) -C client test-profile

# Firefox UI and packaged CLI flows against the real local API and isolated databases.
# Provisions PostgreSQL; installs npm dependencies and Firefox when needed.
test-e2e:
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  cargo run --quiet --features test-containers --example postgres-tests -- \
	  $(MAKE) -C client test-e2e

# Live deployment: register/restore, upload random blobs, edit tags, verify downloads,
# and delete test media. Requires private invitation/password/recovery files.
test-smoke:
	$(MAKE) -C client test-smoke SMOKE_SERVER="$(SMOKE_SERVER)" SMOKE_DIR="$(abspath $(SMOKE_DIR))"

# Run every suite, including the transfer/resource profile and live deployment test.
# test-db runs all Rust tests once, including those covered by standalone test.
# Recursive recipes run sequentially even with make -j, avoiding shared build races.
test-all:
	$(MAKE) test-client
	$(MAKE) lint
	$(MAKE) test-packages
	$(MAKE) test-db
	$(MAKE) test-profile
	$(MAKE) test-e2e
	$(MAKE) test-smoke

# Rust/JavaScript static analysis and all formatting checks.
lint:
	cargo clippy --all-targets --all-features -- -D warnings
	$(MAKE) -C client lint
	$(MAKE) format-check

# Check Rust and client formatting without changing source files.
format-check:
	cargo fmt --all -- --check
	$(MAKE) -C client format-check

# Apply Rust and client formatting, then run the repository lint checks.
format-write:
	cargo fmt --all
	$(MAKE) -C client format-write

# Run before committing: format files, apply Biome fixes, then check lint and formatting.
pre-commit:
	$(MAKE) format-write
	$(MAKE) lint

# Fetch Cargo vulnerability advisories; optional security check, outside test-all.
# Requires cargo-audit and external network access.
audit:
	cargo audit

# Compatibility aliases for existing commands; canonical suite names use test-*.
client-test: test-client
e2e: test-e2e
smoketest: test-smoke

# Container build and deployment.
container:
	podman build -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -e I2N_DATABASE_URL localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
