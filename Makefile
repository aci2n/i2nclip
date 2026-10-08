# Basic project commands. `make` builds the binary into target/.

IMAGE ?= i2nclip
TAG ?= latest
PORT ?= 8080
HOST ?= deploy@example.com
CONNECTION ?= remote-podman

GH_REPO ?= aci2n/i2nclip

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
e2e:
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

# Build the image and copy it to a remote rootless Podman host (set HOST and CONNECTION).
push: container
	remote_uid=$$(ssh $(HOST) 'id -u'); \
	podman system connection rm $(CONNECTION) >/dev/null 2>&1 || true; \
	podman --ssh=native system connection add $(CONNECTION) \
		"ssh://$(HOST)/run/user/$$remote_uid/podman/podman.sock"; \
	ssh $(HOST) 'export XDG_RUNTIME_DIR=/run/user/$$(id -u); systemctl --user start podman.socket'; \
	podman --ssh=native image scp $(IMAGE):$(TAG) $(CONNECTION)::
