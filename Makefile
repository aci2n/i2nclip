# `make` builds the Rust server and Svelte client. Run npm ci --prefix client once.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com
# Avoid rootless pasta's /dev/net/tun requirement during image builds.
CONTAINER_NETWORK ?= host
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
	cargo run

# -----------------------------------------------------------------------------
# Tests and verification, grouped by required access.
# All commands write local build/cache files and may launch child processes.
# Install toolchains and client dependencies first; dependency downloads need network.
# -----------------------------------------------------------------------------

.PHONY: test client-test lint format-check test-packages test-db e2e audit smoketest

# Local checks: no browser, database, container runtime, or external service.
test: client-test
	cargo test

client-test:
	$(MAKE) -C client test

lint:
	cargo clippy --all-targets --all-features -- -D warnings
	$(MAKE) -C client lint
	$(MAKE) format-check

format-check:
	cargo fmt --all -- --check
	$(MAKE) -C client format-check

# Build archives and run their contents locally; requires zip, unzip, and GNU tar.
test-packages:
	$(MAKE) -C client test-packages

# Local PostgreSQL: database creation/deletion and local TCP connections.
# Without I2N_TEST_DATABASE_URL, requires a Docker/Podman API socket and may pull images.
# Testcontainers owns PostgreSQL; fixtures own isolated databases.
test-db:
	I2N_TEST_CONTAINER_NETWORK="$(CONTAINER_NETWORK)" \
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  cargo run --quiet --features test-containers --example postgres-tests -- \
	  cargo test --features postgres-tests $(TEST_ARGS)

# Firefox + local servers + PostgreSQL: browser launch, loopback listeners/connections,
# and database creation/deletion. Set I2N_TEST_DATABASE_URL to a disposable admin URL.
# Also downloads npm dependencies and Firefox; this target does not provision PostgreSQL.
e2e:
	$(MAKE) -C client e2e

# External network, read-only: fetch vulnerability advisories for Cargo.lock.
# Install cargo-audit once with cargo install cargo-audit --locked.
audit:
	cargo audit

# External network, writes to the selected deployment: register an identity, upload,
# edit tags, and delete test media. Requires private invitation/password files.
smoketest:
	$(MAKE) -C client smoketest SMOKE_SERVER="$(SMOKE_SERVER)" SMOKE_DIR="$(abspath $(SMOKE_DIR))"

# Container build and deployment.
container:
	podman build --network=$(CONTAINER_NETWORK) -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -e I2N_DATABASE_URL localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
