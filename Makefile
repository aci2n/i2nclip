# `make` builds the Rust server and Svelte client. Run npm ci --prefix client once.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com
COMPOSE ?= podman compose
DEV_PORT ?= 8080
DEV_DB_PORT ?= 5432
DEV_ORIGIN ?= http://localhost:$(DEV_PORT)
# Import policy uses CLI options supported by stable rustfmt 1.10.0.
RUSTFMT_CONFIG := imports_granularity=Crate,group_imports=StdExternalCrate

DEV_DB_URL ?= postgresql://i2nclip:i2nclip-dev@127.0.0.1:$(DEV_DB_PORT)/i2nclip?sslmode=disable
# Bound case-level concurrency without limiting concurrency inside a test.
export RUST_TEST_THREADS ?= 4

# Honor explicit socket configuration; support Docker and rootless Podman.
ifndef DOCKER_HOST
TEST_CONTAINER_SOCKET := $(or $(wildcard /var/run/docker.sock),$(wildcard $(XDG_RUNTIME_DIR)/podman/podman.sock),$(wildcard /run/user/$(shell id -u)/podman/podman.sock))
ifneq ($(TEST_CONTAINER_SOCKET),)
export DOCKER_HOST := unix://$(TEST_CONTAINER_SOCKET)
endif
endif

-include local.mk

.DEFAULT_GOAL := build
.PHONY: build client extension run
.PHONY: dev dev-db dev-down dev-otc test test-client test-build
.PHONY: test-db test-profile test-e2e test-all
.PHONY: lint format-check format-write pre-commit audit
.PHONY: lint-rust lint-client format-write-rust format-write-client test-hooks
.PHONY: container push

build: client
	cargo build

client:
	$(MAKE) -C client build

extension:
	$(MAKE) -C client $@

run:
	I2N_ORIGIN="$(DEV_ORIGIN)" I2N_DATABASE_URL="$(DEV_DB_URL)" cargo run $(RUN_ARGS)

# Local containers: web/API and PostgreSQL ports bind to loopback.
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

# Fast checks: client unit tests, Svelte type checking, and Rust unit/config tests.
test: test-client
	cargo test

# Client unit tests, plus the Svelte checker.
test-client:
	$(MAKE) -C client test

# Build and verify the web and unpacked extension directories.
test-build:
	$(MAKE) -C client test-build

# Rust PostgreSQL API/protocol tests using isolated databases; TEST_ARGS adds filters.
# Provisions PostgreSQL through Docker/Podman unless I2N_TEST_DATABASE_URL is set.
test-db:
	cargo run --quiet --features test-containers --example postgres-tests -- \
	  cargo test --features postgres-tests $(TEST_ARGS)

# Verify maximum-size/chunked transfers and held downloads; report process resources.
# Requires Linux, local Podman and an owned PostgreSQL container.
test-profile:
	cargo build --release --bin i2nclip --example test-server
	cargo build --example test-database
	env -u I2N_TEST_DATABASE_URL cargo run --quiet --features test-containers --example postgres-tests -- \
	  $(MAKE) -C client test-profile

# Firefox and Chromium web flows against the real local API and isolated databases.
# Provisions PostgreSQL; installs npm dependencies and Firefox when needed.
test-e2e:
	cargo run --quiet --features test-containers --example postgres-tests -- \
	  $(MAKE) -C client test-e2e

# Run every portable suite. The Linux/Podman resource profile is optional.
# test-db runs all Rust tests once, including those covered by standalone test.
# Recursive recipes run sequentially even with make -j, avoiding shared build races.
test-all:
	$(MAKE) test-client
	$(MAKE) lint
	$(MAKE) format-check
	$(MAKE) test-build
	$(MAKE) test-db
	$(MAKE) test-e2e

# Rust/TypeScript static analysis and all formatting checks.
lint: lint-rust lint-client

lint-rust:
	cargo clippy --all-targets --all-features -- -D warnings

lint-client:
	$(MAKE) -C client check

# Check Rust formatting; Biome formatting and imports are covered by lint.
format-check:
	cargo fmt --all -- --check --config $(RUSTFMT_CONFIG)

# Apply formatting explicitly; hooks check staged subsystems without rewriting.
format-write: format-write-rust format-write-client

format-write-rust:
	cargo fmt --all -- --config $(RUSTFMT_CONFIG)

format-write-client:
	$(MAKE) -C client fix

# Check only staged subsystems. Hooks never rewrite the working tree.
pre-commit:
	sh .githooks/check-staged.sh

test-hooks:
	sh .githooks/tests/check-staged.sh

# Fetch Cargo vulnerability advisories; optional security check, outside test-all.
# Requires cargo-audit and external network access.
audit:
	cargo audit
	$(MAKE) -C client audit

# Container build and deployment.
container:
	podman build -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -e I2N_DATABASE_URL localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
