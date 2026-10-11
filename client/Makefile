# Frontend commands. Run directly here or through the repository Makefile.
NODE ?= $(HOME)/.nvm/versions/node/v$(strip $(file <.nvmrc))/bin/node

.DEFAULT_GOAL := build
.PHONY: build web extension cli packages dev-extension

SMOKE_SERVER ?= https://clip.i2n.duckdns.org
SMOKE_DIR ?= $(HOME)/.config/i2nclip/smoke

build:
	npm run build

# Build and package only the selected client target.
web extension cli:
	npm run pack:$@

packages: web extension cli

# Build once before Firefox starts, then rebuild and reload on source changes.
# npx downloads web-ext on first use. Ctrl-C also stops the build watcher.
dev-extension: export PATH := $(dir $(NODE)):$(PATH)
dev-extension:
	@node node_modules/vite/bin/vite.js build --config vite.extension.config.js --watch & \
	watcher=$$!; \
	trap 'kill "$$watcher" 2>/dev/null || true; wait "$$watcher" 2>/dev/null || true' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	npx --yes web-ext run --source-dir dist/extension

# -----------------------------------------------------------------------------
# Tests and verification (repository Makefile lists all permission groups).
# -----------------------------------------------------------------------------

.PHONY: test lint format-check test-packages test-profile test-e2e test-smoke e2e smoketest

# Unit tests for shared libraries, CLI, and smoke runner, plus Svelte type checking.
test:
	npm run test
	npm run check

# Check JavaScript/Svelte for static analysis errors.
lint:
	npm run lint

# Check client formatting without changing files.
format-check:
	npm run format:check

# Build and inspect all archives, then run the extracted CLI; zip/unzip/GNU tar required.
test-packages: packages
	npm run test:packages

# Firefox UI and packaged CLI integration tests against the real local API.
# Requires browser launch, local servers, and disposable PostgreSQL admin access.
# I2N_TEST_DATABASE_URL must be set separately. Downloads dependencies and Firefox.
# Override NODE when Node 22 is installed outside the default nvm directory.
test-e2e: export PATH := $(dir $(NODE)):$(PATH)
test-e2e:
	@test -x "$(NODE)" || { echo "Node 22 not found at $(NODE); run nvm install or set NODE" >&2; exit 1; }
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
	npx playwright install firefox
	npm run e2e

# Live CLI upload, metadata/tag edits, verified download, and deletion.
# External network and deployment writes; private credentials required.
test-smoke:
	@"$(NODE)" smoke/index.js --server "$(SMOKE_SERVER)" --directory "$(SMOKE_DIR)"

# Linux transfer/resource assertions; root target supplies the server build and database.
test-profile:
	"$(NODE)" tests/profile-postgres.js

# Compatibility aliases.
e2e: test-e2e
smoketest: test-smoke
