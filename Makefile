# `make` builds the Rust server and Svelte client. Run npm ci --prefix client once.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com
# Avoid rootless pasta's /dev/net/tun requirement during image builds.
CONTAINER_NETWORK ?= host

-include local.mk

.DEFAULT_GOAL := build
.PHONY: build client client-test lint format-check e2e extension dev-extension run test test-db audit container push

build: client
	cargo build

client:
	$(MAKE) -C client build

client-test:
	$(MAKE) -C client test

lint:
	cargo clippy --all-targets --all-features -- -D warnings
	$(MAKE) -C client lint
	$(MAKE) format-check

format-check:
	cargo fmt --all -- --check
	$(MAKE) -C client format-check

e2e extension dev-extension:
	$(MAKE) -C client $@

run:
	cargo run

test: client-test
	cargo test

# Explicit opt-in: testcontainers owns PostgreSQL; fixtures own isolated databases.
test-db:
	DOCKER_HOST="$${DOCKER_HOST:-unix://$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/podman/podman.sock}" \
	  cargo run --quiet --features test-containers --example postgres-tests -- \
	  cargo test --features postgres-tests $(TEST_ARGS)

# Advisory scan of Cargo.lock (install once: cargo install cargo-audit --locked).
audit:
	cargo audit

container:
	podman build --network=$(CONTAINER_NETWORK) -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -e I2N_DATABASE_URL localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
