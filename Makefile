# `make` builds the Rust server and Svelte client. Run npm ci --prefix client once.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com

-include local.mk

.DEFAULT_GOAL := build
.PHONY: build client client-test lint format-check e2e extension dev-extension run test audit container push

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

# Advisory scan of Cargo.lock (install once: cargo install cargo-audit --locked).
audit:
	cargo audit

container:
	podman build -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -v $(IMAGE)-data:/var/lib/i2nclip:Z localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
