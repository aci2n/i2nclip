# Basic project commands. `make` builds the binary into target/.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com

GH_REPO ?= aci2n/i2nclip

-include local.mk

NODE22 ?= $(HOME)/.nvm/versions/node/v$(strip $(file <.nvmrc))/bin/node

.PHONY: build run test audit e2e container push extension release-extension

build:
	cargo build

run:
	cargo run

test:
	cargo test
	node --test client/*.test.js

# Advisory scan of Cargo.lock (install once: cargo install cargo-audit --locked).
audit:
	cargo audit

# Renders the extension in Firefox and walks setup, upload, and both themes.
# Override NODE22 for a Node 22 installation outside the default nvm directory.
e2e: export PATH := $(dir $(NODE22)):$(PATH)
e2e:
	@test -x "$(NODE22)" || { echo "Node 22 not found at $(NODE22); run nvm install or set NODE22" >&2; exit 1; }
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
	npx playwright install firefox
	npx playwright test

# Zip the add-on only. Testers load manifest.json from the unzipped folder.
extension:
	python3 scripts/pack-extension.py

# Bump manifest.json version first. Builds i2nclip.xpi, updates extension/updates.json,
# and creates or refreshes the matching GitHub release (needs gh auth).
release-extension:
	GH_REPO=$(GH_REPO) python3 scripts/release-extension.py

container:
	podman build -t $(IMAGE):$(TAG) -f Containerfile .
	@echo "podman run --rm -p $(PORT):8080 -e I2N_ORIGIN=https://clip.example.com -v $(IMAGE)-data:/var/lib/i2nclip:Z localhost/$(IMAGE):$(TAG)"

# Build the image and load it on the remote Podman host over SSH (set HOST).
push: SHELL := /bin/bash
push: .SHELLFLAGS := -e -o pipefail -c
push: container
	podman save $(IMAGE):$(TAG) | ssh $(HOST) podman load
