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

# Tests and verification. Install toolchains and client dependencies first.
.PHONY: test test-client test-packages test-db test-profile test-e2e test-smoke test-all
.PHONY: lint format-check audit client-test e2e smoketest

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

# Rust PostgreSQL API/protocol tests using isolated databases; TEST_ARGS adds filters.
# Provisions PostgreSQL through Docker/Podman unless I2N_TEST_DATABASE_URL is set.
test-db:
	I2N_TEST_CONTAINER_NETWORK="$(CONTAINER_NETWORK)" \
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  cargo run --quiet --features test-containers --example postgres-tests -- \
	  cargo test --features postgres-tests $(TEST_ARGS)

# Verify maximum-size/chunked transfers and held downloads; report process resources.
# Requires Linux, local Podman, port 8080 free, and an owned PostgreSQL container.
test-profile:
	cargo build --release
	cargo build --example test-database
	I2N_TEST_CONTAINER_NETWORK="$(CONTAINER_NETWORK)" \
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  env -u I2N_TEST_DATABASE_URL cargo run --quiet --features test-containers --example postgres-tests -- \
	  $(MAKE) -C client test-profile

# Firefox UI and packaged CLI flows against the real local API and isolated databases.
# Provisions PostgreSQL; installs npm dependencies and Firefox when needed.
test-e2e:
	I2N_TEST_CONTAINER_NETWORK="$(CONTAINER_NETWORK)" \
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
	podman build --network=$(CONTAINER_NETWORK) -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -e I2N_DATABASE_URL localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
